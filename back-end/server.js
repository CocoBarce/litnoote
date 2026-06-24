import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import { fileURLToPath } from "url";
import { setupcolaborativo } from "./colaborativo.js";
import { funcionn, funcionAdvanced } from "./Quiz.js";
import {
  canAccessDocument,
  createDocumentId,
  documentFile,
  migrateLegacyDocuments,
  readDocuments,
  serializeDocument,
  writeDocuments
} from "./documentStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_FILE = path.join(__dirname, "usuarios.json");
const ATTACHMENTS_DIR = path.join(__dirname, "attachments");
const SESSION_SECRET_FILE = path.join(__dirname, ".session-secret");
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SESSION_TTL = "12h";
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".csv", ".rtf", ".odt", ".ods", ".odp",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"
]);

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function writeUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

async function migratePasswordHashes() {
  const users = readUsers();
  let changed = false;
  for (const user of Object.values(users)) {
    if (user.password && !/^\$2[aby]\$/.test(user.password)) {
      user.password = await bcrypt.hash(user.password, 12);
      changed = true;
    }
  }
  if (changed) writeUsers(users);
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  if (!fs.existsSync(SESSION_SECRET_FILE)) {
    fs.writeFileSync(SESSION_SECRET_FILE, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(SESSION_SECRET_FILE, "utf8").trim();
}

const SESSION_SECRET = getSessionSecret();

function createSessionToken(username) {
  return jwt.sign({ sub: username, type: "session" }, SESSION_SECRET, { expiresIn: SESSION_TTL });
}

function verifySessionToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    return payload?.type === "session" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const header = String(req.header("authorization") || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

await migratePasswordHashes();
migrateLegacyDocuments();

// XP level table: [minXP, name]
const LEVELS = [
  [0, 'Novato/a'], [300, 'Aprendiz'], [700, 'Estudiante'],
  [1400, 'Curioso/a'], [2500, 'Analista'], [4000, 'Pensador/a'],
  [6000, 'Explorador/a'], [8500, 'Investigador/a'], [12000, 'Erudito/a'], [16000, 'Maestro/a']
];

let quiz1v1Rooms = {};

function computeLevel(xp) {
  let level = 1, name = LEVELS[0][1];
  for (let i = 0; i < LEVELS.length; i++) {
    if (xp >= LEVELS[i][0]) { level = i + 1; name = LEVELS[i][1]; }
  }
  const nextXP = LEVELS[level] ? LEVELS[level][0] : LEVELS[LEVELS.length-1][0] + 5000;
  const prevXP = LEVELS[level-1][0];
  return { level, name, xp, xpNeeded: nextXP, xpPrev: prevXP };
}

function checkBadges(u) {
  const earned = new Set(u.badges || []);
  if ((u.streak || 0) >= 7 && !earned.has('racha_7')) earned.add('racha_7');
  if ((u.streakMax || 0) >= 18 && !earned.has('racha_18')) earned.add('racha_18');
  const allHistory = u.quizHistory || [];
  if (allHistory.some(q => q.score === q.total && q.total >= 5) && !earned.has('primer_10')) earned.add('primer_10');
  if ((u.xp || 0) >= 16000 && !earned.has('nivel_10')) earned.add('nivel_10');
  if ((u.noteWords || 0) >= 500 && !earned.has('resumidor')) earned.add('resumidor');
  if ((u.quizHistory || []).some(q => q.mode === '1v1') && !earned.has('duo_1v1')) earned.add('duo_1v1');
  if ((u.quizHistory || []).some(q => q.total >= 10) && !earned.has('maraton')) earned.add('maraton');
  if ((u.quizHistory || []).some(q => {
    const hour = new Date(q.createdAt || q.date).getHours();
    return hour >= 5 && hour < 9;
  }) && !earned.has('madrugador')) earned.add('madrugador');
  u.badges = [...earned];
}

function updateStreak(u) {
  const today = new Date().toISOString().slice(0, 10);
  if (u.lastActiveDate === today) return; // already counted today
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (u.lastActiveDate === yesterday) {
    u.streak = (u.streak || 0) + 1;
  } else if (u.lastActiveDate !== today) {
    u.streak = 1; // reset or start
  }
  u.streakMax = Math.max(u.streakMax || 0, u.streak);
  u.lastActiveDate = today;
}

const app = express();
const server = createServer(app);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/i.test(origin);
}

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      callback(isAllowedOrigin(origin) ? null : new Error("Origen no permitido"), isAllowedOrigin(origin));
    },
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1_000_000
});

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const username = verifySessionToken(token);
  if (username && readUsers()[username]) socket.username = username;
  next();
});

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

function safeAttachmentName(name) {
  return path.basename(String(name || "archivo"))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 180);
}

function attachmentMetadataFile(docId) {
  return path.join(ATTACHMENTS_DIR, docId, "attachments.json");
}

function validDocumentId(docId) {
  return /^[a-zA-Z0-9_-]+$/.test(String(docId || ""));
}

function readAttachmentMetadata(docId) {
  const file = attachmentMetadataFile(docId);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAttachmentMetadata(docId, data) {
  const directory = path.join(ATTACHMENTS_DIR, docId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(attachmentMetadataFile(docId), JSON.stringify(data, null, 2));
}

app.post(
  "/api/documents/:docId/attachments",
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
  (req, res) => {
    const docId = req.params.docId;
    const user = verifySessionToken(bearerToken(req));
    if (!user) {
      res.status(401).json({ error: "Iniciá sesión para adjuntar archivos" });
      return;
    }
    if (!validDocumentId(docId)) {
      res.status(400).json({ error: "Documento inválido" });
      return;
    }
    const document = readDocuments()[docId];
    if (!canAccessDocument(document, user)) {
      res.status(403).json({ error: "No tenés acceso a este documento" });
      return;
    }

    let originalName;
    try {
      originalName = decodeURIComponent(req.header("x-file-name") || "archivo");
    } catch {
      originalName = "archivo";
    }
    originalName = safeAttachmentName(originalName);
    const extension = path.extname(originalName).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
      res.status(415).json({ error: "Ese tipo de archivo no está permitido" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "El archivo está vacío" });
      return;
    }

    const id = crypto.randomUUID();
    const storedName = id + extension;
    const directory = path.join(ATTACHMENTS_DIR, docId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, storedName), req.body);

    const metadata = readAttachmentMetadata(docId);
    metadata[id] = {
      id,
      originalName,
      storedName,
      contentType: String(req.header("content-type") || "application/octet-stream"),
      size: req.body.length,
      uploadedBy: user,
      createdAt: new Date().toISOString()
    };
    writeAttachmentMetadata(docId, metadata);

    res.status(201).json({
      id,
      name: originalName,
      size: req.body.length,
      url: `/api/documents/${encodeURIComponent(docId)}/attachments/${id}`
    });
  }
);

app.get("/api/documents/:docId/attachments/:attachmentId", (req, res) => {
  const { docId, attachmentId } = req.params;
  if (!validDocumentId(docId) || !/^[a-f0-9-]{36}$/i.test(attachmentId)) {
    res.status(400).send("Archivo inválido");
    return;
  }
  const attachment = readAttachmentMetadata(docId)[attachmentId];
  if (!attachment) {
    res.status(404).send("Archivo no encontrado");
    return;
  }
  const file = path.join(ATTACHMENTS_DIR, docId, attachment.storedName);
  if (!fs.existsSync(file)) {
    res.status(404).send("Archivo no encontrado");
    return;
  }
  res.setHeader("Content-Type", attachment.contentType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`
  );
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname, "..", "front-end",)));
let usuarios = readUsers();
let proximoid = Object.values(usuarios).reduce((max, u) => Math.max(max, u.id), 0) + 1;
io.on("connection", (socket) => {
  socket.use(([event, payload], next) => {
    if (event === "login" || event === "registro") {
      next();
      return;
    }
    if (!socket.username) {
      socket.emit("session-error", { mensaje: "Tu sesión venció. Volvé a iniciar sesión." });
      next(new Error("Sesión requerida"));
      return;
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      payload.user = socket.username;
    }
    next();
  });

    socket.on("cargarNORMAL", (data) => {
    let usuarios2 = readUsers();
    if (!data.user || !usuarios2[data.user]) {
      socket.emit("cargar1", { rooms: [], favoritos: [], xp: 0, level: computeLevel(0), streak: 0, profiles: [], badges: [] });
      return;
    }
    const u = usuarios2[data.user];
    const documents = readDocuments();
    // Update streak on load
    updateStreak(u);
    writeUsers(usuarios2);
    socket.emit("cargar1", {
      rooms: (u.rooms || []).map(id => documents[id]).filter(Boolean).map(doc => serializeDocument(doc, data.user)),
      sharedDocuments: (u.sharedRooms || []).map(id => documents[id]).filter(Boolean).map(doc => serializeDocument(doc, data.user)),
      pendingInvitations: Object.values(documents)
        .filter(doc => (doc.pendingInvites || []).some(invite => invite.username === data.user))
        .map(doc => ({
          id: doc.id,
          title: doc.title,
          owner: doc.owner,
          invitedAt: doc.pendingInvites.find(invite => invite.username === data.user)?.invitedAt
        })),
      favoritos: u.favoritos || [],
      xp: u.xp || 0,
      level: computeLevel(u.xp || 0),
      streak: u.streak || 0,
      streakMax: u.streakMax || 0,
      profiles: u.profiles || [],
      badges: u.badges || [],
      quizHistory: u.quizHistory || []
    });
})

  socket.on("toggleFavorito", (data) => {
    if (!data.user || !data.docId) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    if (!canAccessDocument(readDocuments()[data.docId], data.user)) return;
    const u = usuarios2[data.user];
    if (!u.favoritos) u.favoritos = [];
    const idx = u.favoritos.indexOf(data.docId);
    if (idx === -1) u.favoritos.push(data.docId);
    else u.favoritos.splice(idx, 1);
    writeUsers(usuarios2);
  })
  
  console.log("papu conectado");
  socket.on("generartrivia", (data) => {
    if (!socket.username) {
      socket.emit("trivia-error", { mensaje: "Tu sesión venció. Volvé a iniciar sesión." });
      return;
    }
    const input = typeof data === "string" ? data : "";
    funcionn(socket, input, { user: socket.username, ip: socket.handshake.address });
  });

  socket.on("generartrivia-avanzado", (data) => {
    if (!socket.username) {
      socket.emit("trivia-error", { mensaje: "Tu sesión venció. Volvé a iniciar sesión." });
      return;
    }
    const input = typeof data === "string" ? data : "";
    funcionAdvanced(socket, input, { user: socket.username, ip: socket.handshake.address });
  });
  
  socket.on("registro", async (data) => {
    usuarios = readUsers();
    const email = String(data.email || "").trim().toLowerCase();
    if (usuarios[data.user]) {
      socket.emit("registro-error", { mensaje: "El usuario ya existe" });
      return;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      socket.emit("registro-error", { mensaje: "Ingresá un email válido" });
      return;
    } else if (Object.values(usuarios).some(user => user.email === email)) {
      socket.emit("registro-error", { mensaje: "Ese email ya está registrado" });
      return;
    } else if (data.password.length < 6) {
      socket.emit("registro-error", { mensaje: "La contraseña tiene que tener al menos 6 caracteres" });
      return;
    } else {
      usuarios[data.user] = {
        id: proximoid,
        password: await bcrypt.hash(data.password, 12),
        username: data.user,
        email,
        intervalo: 10,
        rooms: [],
        sharedRooms: [],
        favoritos: []
      }
      proximoid++;
      socket.emit("registro-exito", { mensaje: "Usuario registrado con éxito" });
      writeUsers(usuarios);
    }
  });
    socket.on("login", async (data) => {
    usuarios = readUsers();
    const loginValue = String(data.user || "").trim().toLowerCase();
    const userObj = usuarios[data.user] || Object.values(usuarios).find(user => user.email?.toLowerCase() === loginValue);
    if (!userObj) {
      socket.emit("login-error", { mensaje: "El usuario no existe" });
      return;
    } else {
      const passwordIsHash = /^\$2[aby]\$/.test(userObj.password || "");
      const validPassword = passwordIsHash
        ? await bcrypt.compare(data.password, userObj.password)
        : userObj.password === data.password;
      if (!validPassword) {
        socket.emit("login-error", { mensaje: "Contraseña incorrecta" });
        return;
      }
      if (!passwordIsHash) {
        userObj.password = await bcrypt.hash(data.password, 12);
        writeUsers(usuarios);
      }
    }
  socket.username = userObj.username;

  socket.emit("login-exito", {
    mensaje: "Bienvenido",
    token: createSessionToken(userObj.username),
    username: userObj.username
  });
socket.emit("userDEV", userObj.username);
        
        
      
    
});
  socket.on("actualizarEmail", (data) => {
    const users = readUsers();
    const current = users[data.user];
    const email = String(data.email || "").trim().toLowerCase();
    if (!current) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      socket.emit("emailActualizado", { ok: false, mensaje: "Ingresá un email válido" });
      return;
    }
    if (Object.values(users).some(user => user.username !== data.user && user.email === email)) {
      socket.emit("emailActualizado", { ok: false, mensaje: "Ese email ya pertenece a otra cuenta" });
      return;
    }
    current.email = email;
    writeUsers(users);
    socket.emit("emailActualizado", { ok: true, email, mensaje: "Email actualizado" });
  });

  socket.on("cargarCuenta", (data) => {
    const current = readUsers()[data.user];
    if (current) socket.emit("cuentaData", { email: current.email || "" });
  });

  socket.on("crearDocumento", (data) => {
    const users = readUsers();
    const owner = users[data.user];
    const title = String(data.title || "").trim();
    if (!owner || !title) {
      socket.emit("documentoError", { mensaje: "Ingresá un nombre para el documento" });
      return;
    }
    const documents = readDocuments();
    const id = createDocumentId();
    const document = {
      id,
      title,
      owner: data.user,
      collaborators: [],
      pendingInvites: [],
      createdAt: new Date().toISOString()
    };
    documents[id] = document;
    if (!owner.rooms) owner.rooms = [];
    owner.rooms.push(id);
    fs.writeFileSync(documentFile(id), JSON.stringify({ t: "", u: [data.user] }, null, 2));
    writeDocuments(documents);
    writeUsers(users);
    socket.emit("documentoCreado", { document: serializeDocument(document, data.user) });
  });

  socket.on("cargarCompartir", (data) => {
    const document = readDocuments()[data.docId];
    if (!canAccessDocument(document, data.user)) {
      socket.emit("documentAccessDenied", { docId: data.docId });
      return;
    }
    socket.emit("compartirData", {
      id: document.id,
      title: document.title,
      owner: document.owner,
      collaborators: document.collaborators || [],
      canManage: document.owner === data.user
    });
  });

  socket.on("invitarDocumento", (data) => {
    const users = readUsers();
    const documents = readDocuments();
    const document = documents[data.docId];
    const email = String(data.email || "").trim().toLowerCase();
    if (!document || document.owner !== data.user) {
      socket.emit("invitacionResultado", { ok: false, mensaje: "Sólo el propietario puede invitar personas" });
      return;
    }
    const invitedUser = Object.values(users).find(user => user.email?.toLowerCase() === email);
    if (!invitedUser) {
      socket.emit("invitacionResultado", { ok: false, mensaje: "No hay una cuenta de Litnoote con ese email" });
      return;
    }
    if (invitedUser.username === data.user) {
      socket.emit("invitacionResultado", { ok: false, mensaje: "Ya sos propietario de este documento" });
      return;
    }
    if ((document.collaborators || []).includes(invitedUser.username)) {
      socket.emit("invitacionResultado", { ok: false, mensaje: "Esa persona ya tiene acceso" });
      return;
    }
    if (!document.pendingInvites) document.pendingInvites = [];
    if (!document.pendingInvites.some(invite => invite.username === invitedUser.username)) {
      document.pendingInvites.push({
        username: invitedUser.username,
        email,
        invitedBy: data.user,
        invitedAt: new Date().toISOString()
      });
    }
    writeDocuments(documents);
    socket.emit("invitacionResultado", { ok: true, mensaje: `Invitación enviada a ${email}` });
    io.emit("invitacionesCambiaron");
  });

  socket.on("responderInvitacion", (data) => {
    const users = readUsers();
    const documents = readDocuments();
    const document = documents[data.docId];
    const current = users[data.user];
    if (!document || !current) return;
    const invitation = (document.pendingInvites || []).find(invite => invite.username === data.user);
    if (!invitation) return;
    document.pendingInvites = document.pendingInvites.filter(invite => invite.username !== data.user);
    if (data.accept) {
      if (!document.collaborators) document.collaborators = [];
      if (!document.collaborators.includes(data.user)) document.collaborators.push(data.user);
      if (!current.sharedRooms) current.sharedRooms = [];
      if (!current.sharedRooms.includes(document.id)) current.sharedRooms.push(document.id);
    }
    writeDocuments(documents);
    writeUsers(users);
    socket.emit("invitacionRespondida", { ok: true, accepted: Boolean(data.accept), docId: document.id });
    io.emit("invitacionesCambiaron");
  });

  socket.on("revocarAcceso", (data) => {
    const users = readUsers();
    const documents = readDocuments();
    const document = documents[data.docId];
    if (!document || document.owner !== data.user) return;
    document.collaborators = (document.collaborators || []).filter(username => username !== data.username);
    if (users[data.username]) {
      const removedUser = users[data.username];
      removedUser.sharedRooms = (removedUser.sharedRooms || []).filter(id => id !== data.docId);
      removedUser.favoritos = (removedUser.favoritos || []).filter(id => id !== data.docId);
      (removedUser.profiles || []).forEach(profile => {
        profile.docs = (profile.docs || []).filter(id => id !== data.docId);
      });
    }
    writeDocuments(documents);
    writeUsers(users);
    socket.emit("accesoRevocado", { username: data.username });
    io.to(data.docId).emit("documentAccessChanged");
  });

  socket.on("abandonarCompartido", (data) => {
    const users = readUsers();
    const documents = readDocuments();
    const document = documents[data.docId];
    const current = users[data.user];
    if (!document || !current || document.owner === data.user) return;
    document.collaborators = (document.collaborators || []).filter(username => username !== data.user);
    current.sharedRooms = (current.sharedRooms || []).filter(id => id !== data.docId);
    current.favoritos = (current.favoritos || []).filter(id => id !== data.docId);
    (current.profiles || []).forEach(profile => {
      profile.docs = (profile.docs || []).filter(id => id !== data.docId);
    });
    writeDocuments(documents);
    writeUsers(users);
    socket.emit("compartidoAbandonado", { docId: data.docId });
  });

  socket.on("intervalo", (data) => {
    if (!socket.username || !usuarios[socket.username]) return;
    let danonino = data * 10000;
    usuarios[socket.username].intervalo = danonino;
    writeUsers(usuarios);
  })

  // Create study profile
  socket.on("crearPerfil", (data) => {
    if (!data.user) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    const u = usuarios2[data.user];
    if (!u.profiles) u.profiles = [];
    const newProfile = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      nombre: data.nombre,
      materia: data.materia || '',
      color: data.color || '#985CF9',
      examDate: data.examDate || null,
      docs: [],
      quizCount: 0,
      lastQuizScore: null,
      lastQuizXP: 0,
      domain: 0,
      noteWords: 0,
      summaryProgress: 0,
      createdAt: new Date().toISOString()
    };
    u.profiles.push(newProfile);
    // Award XP for creating profile
    u.xp = (u.xp || 0) + 20;
    checkBadges(u);
    writeUsers(usuarios2);
    socket.emit("perfilCreado", { profile: newProfile, xp: u.xp, level: computeLevel(u.xp), xpGained: 20 });
  });

  // Delete study profile
  socket.on("eliminarPerfil", (data) => {
    if (!data.user || !data.profileId) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    const u = usuarios2[data.user];
    u.profiles = (u.profiles || []).filter(p => p.id !== data.profileId);
    writeUsers(usuarios2);
    socket.emit("perfilEliminado", { profileId: data.profileId });
  });

  // Assign a document to exactly one profile (or remove its assignment).
  socket.on("assignDocToPerfil", (data) => {
    if (!data.user || !data.docId) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    if (!canAccessDocument(readDocuments()[data.docId], data.user)) return;
    const u = usuarios2[data.user];
    const documents = readDocuments();
    (u.profiles || []).forEach(profile => {
      profile.docs = (profile.docs || []).filter(docId => docId !== data.docId);
    });
    const profile = (u.profiles || []).find(p => p.id === data.profileId);
    if (profile && !profile.docs.includes(data.docId)) profile.docs.push(data.docId);
    writeUsers(usuarios2);
    socket.emit("docPerfilAsignado", {
      profileId: profile ? profile.id : null,
      docId: data.docId,
      profiles: u.profiles || []
    });
  });

  // Register quiz result - awards XP
  socket.on("registrarQuizResult", (data) => {
    if (!data.user) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    const u = usuarios2[data.user];
    const score = Math.max(0, Number(data.score) || 0);
    const total = Math.max(1, Number(data.total) || 10);
    const resultId = data.resultId || null;
    if (resultId && (u.quizHistory || []).some(q => q.resultId === resultId)) {
      socket.emit("quizResultRegistrado", {
        xp: u.xp || 0,
        level: computeLevel(u.xp || 0),
        xpEarned: 0,
        badges: u.badges || [],
        duplicate: true
      });
      return;
    }
    const xpEarned = Math.round((score / total) * 150);
    u.xp = (u.xp || 0) + xpEarned;
    if (!u.quizHistory) u.quizHistory = [];
    const createdAt = new Date().toISOString();
    u.quizHistory.push({
      resultId,
      date: createdAt.slice(0, 10),
      createdAt,
      score,
      total,
      xpEarned,
      profileId: data.profileId || null,
      docId: data.docId || null,
      mode: data.mode || 'normal'
    });
    // Update profile if provided
    if (data.profileId) {
      const profile = (u.profiles || []).find(p => p.id === data.profileId);
      if (profile) {
        profile.quizCount = (profile.quizCount || 0) + 1;
        profile.lastQuizScore = `${score}/${total}`;
        profile.lastQuizXP = xpEarned;
        // Update domain: average of all quiz scores for this profile
        const profileQuizzes = u.quizHistory.filter(q => q.profileId === data.profileId);
        profile.domain = Math.round(profileQuizzes.reduce((a,q) => a + q.score/q.total, 0) / profileQuizzes.length * 100);
      }
    }
    checkBadges(u);
    writeUsers(usuarios2);
    socket.emit("quizResultRegistrado", {
      xp: u.xp,
      level: computeLevel(u.xp),
      xpEarned,
      badges: u.badges,
      profile: data.profileId ? (u.profiles || []).find(p => p.id === data.profileId) : null
    });
  });

  // Award XP for writing (called from editor)
  socket.on("awardXP", (data) => {
    if (!data.user || !data.amount) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    const u = usuarios2[data.user];
    if (!u.xpAwards) u.xpAwards = [];
    if (data.awardKey && u.xpAwards.includes(data.awardKey)) {
      socket.emit("xpAwarded", { xp: u.xp || 0, level: computeLevel(u.xp || 0), xpEarned: 0, duplicate: true });
      return;
    }
    const awarded = Math.min(Number(data.amount) || 0, 100);
    u.xp = (u.xp || 0) + awarded;
    if (data.awardKey) u.xpAwards.push(data.awardKey);
    checkBadges(u);
    writeUsers(usuarios2);
    socket.emit("xpAwarded", { xp: u.xp, level: computeLevel(u.xp), xpEarned: awarded });
  });

  socket.on("registrarActividadApunte", (data) => {
    if (!data.user || !data.docId) return;
    const usuarios2 = readUsers();
    const u = usuarios2[data.user];
    if (!u) return;

    if (!u.noteStats) u.noteStats = {};
    const previous = u.noteStats[data.docId] || { wordCount: 0, profileId: null };
    const wordCount = Math.max(0, Number(data.wordCount) || 0);
    u.noteStats[data.docId] = {
      wordCount: Math.max(previous.wordCount || 0, wordCount),
      profileId: data.profileId || null,
      updatedAt: new Date().toISOString()
    };
    u.noteWords = Object.values(u.noteStats).reduce((sum, note) => sum + (note.wordCount || 0), 0);

    (u.profiles || []).forEach(profile => {
      const words = Object.values(u.noteStats)
        .filter(note => note.profileId === profile.id)
        .reduce((sum, note) => sum + (note.wordCount || 0), 0);
      profile.noteWords = words;
      profile.summaryProgress = Math.min(100, Math.round(words / 5));
    });

    const today = new Date().toISOString().slice(0, 10);
    const awardKey = `write:${data.docId}:${today}`;
    if (!u.xpAwards) u.xpAwards = [];
    let xpEarned = 0;
    if (wordCount >= 10 && !u.xpAwards.includes(awardKey)) {
      xpEarned = 15;
      u.xp = (u.xp || 0) + xpEarned;
      u.xpAwards.push(awardKey);
    }

    checkBadges(u);
    writeUsers(usuarios2);
    socket.emit("actividadApunteRegistrada", {
      xp: u.xp || 0,
      level: computeLevel(u.xp || 0),
      xpEarned,
      profiles: u.profiles || [],
      badges: u.badges || []
    });
  });

  // Load progress page data
  socket.on("cargarProgreso", (data) => {
    if (!data.user) return;
    let usuarios2 = readUsers();
    if (!usuarios2[data.user]) return;
    const u = usuarios2[data.user];
    socket.emit("progresoData", {
      xp: u.xp || 0,
      level: computeLevel(u.xp || 0),
      streak: u.streak || 0,
      streakMax: u.streakMax || 0,
      quizHistory: u.quizHistory || [],
      profiles: u.profiles || [],
      badges: u.badges || [],
      rooms: (u.rooms || []).map(id => documents[id]).filter(Boolean).map(doc => serializeDocument(doc, data.user)),
      sharedDocuments: (u.sharedRooms || []).map(id => documents[id]).filter(Boolean).map(doc => serializeDocument(doc, data.user)),
      pendingInvitations: Object.values(documents)
        .filter(doc => (doc.pendingInvites || []).some(invite => invite.username === data.user))
        .map(doc => ({
          id: doc.id,
          title: doc.title,
          owner: doc.owner,
          invitedAt: doc.pendingInvites.find(invite => invite.username === data.user)?.invitedAt
        })),
      noteWords: u.noteWords || 0,
      noteStats: u.noteStats || {}
    });
  });
  // 1v1 quiz socket events
  socket.on("iniciar1v1", (data) => {
    if (!data.docId || !data.user) return;
    quiz1v1Rooms[data.docId] = {
      preguntas: data.preguntas,
      retador: data.user,
      scores: { [data.user]: 0 },
      preguntaActual: 0,
      respuestas: {}
    };
    socket.to(data.docId).emit("reto1v1Recibido", { retador: data.user, docId: data.docId });
  });

  socket.on("aceptar1v1", (data) => {
    const session = quiz1v1Rooms[data.docId];
    if (!session) return;
    session.scores[data.user] = 0;
    io.to(data.docId).emit("comenzar1v1", {
      preguntas: session.preguntas,
      jugadores: Object.keys(session.scores),
      scores: session.scores
    });
  });

  socket.on("respuesta1v1", (data) => {
    const session = quiz1v1Rooms[data.docId];
    if (!session) return;
    if (data.correcto) {
      session.scores[data.user] = (session.scores[data.user] || 0) + 1;
    }
    io.to(data.docId).emit("actualizar1v1", {
      scores: session.scores,
      user: data.user,
      preguntaIndex: data.preguntaIndex,
      correcto: data.correcto
    });
  });

  socket.on("rechazar1v1", (data) => {
    delete quiz1v1Rooms[data.docId];
    socket.to(data.docId).emit("reto1v1Rechazado");
  });
    });

setupcolaborativo(io);
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
