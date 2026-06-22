import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canAccessDocument, documentFile, readDocuments } from "./documentStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let rooms = {};

const PRESENCE_COLORS = [
  "#985CF9", "#2E9E6B", "#E5484D", "#D97706",
  "#0284C7", "#DB2777", "#7C3AED", "#0F766E"
];

function colorForUser(username = "") {
  const hash = [...username].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 0);
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

function emitPresence(io, docId) {
  const members = Object.values(rooms[docId] || {}).map(member => ({
    socketId: member.socketId,
    username: member.username,
    color: member.color,
    photo: member.photo || null
  }));
  io.to(docId).emit("documentPresence", members);
}
function cargarDoc(docId) {
  const file = documentFile(docId);
  let doc;
  if (fs.existsSync(file)) {
    const contenido = fs.readFileSync(file, "utf8");
    doc = JSON.parse(contenido);
  } else {
    doc = { t: "", u: [] };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  }
  return doc;
}

function guardarDoc(docId, doc) {
  const file = documentFile(docId);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

export function setupcolaborativo(io) {
  io.on("connection", (socket) => {
    socket.on("unirse", (data) => {
      if (!data || !data.docId) return;
      const docId = data.docId;
      const user = data.user;
      const document = readDocuments()[docId];
      if (!canAccessDocument(document, user)) {
        socket.emit("documentAccessDenied", { docId });
        return;
      }
      socket.join(docId);
      socket.data.activeDocId = docId;
      socket.data.activeUser = user;
      if (!rooms[docId]) rooms[docId] = {};
      rooms[docId][socket.id] = {
        socketId: socket.id,
        username: user,
        color: colorForUser(user)
      };
      emitPresence(io, docId);

      const doc = cargarDoc(docId);
      if (user !== undefined && !doc.u.includes(user)) {
        doc.u.push(user);
      }
      guardarDoc(docId, doc);

      socket.emit("documentMetadata", {
        id: document.id,
        title: document.title,
        owner: document.owner,
        collaborators: document.collaborators || [],
        canManage: document.owner === user
      });
      socket.emit("loadDocument", doc.t || "");

      socket.on("editDocument", (data) => {
        if (!data || !data.docId) return;
        const editedDocId = data.docId;
        const content = data.content;
        const user = data.user;
        if (!canAccessDocument(readDocuments()[editedDocId], user)) return;

        const doc = cargarDoc(editedDocId);
        if (doc.t === content) return;
        doc.t = content;
        if (!doc.u) doc.u = [];
        if (user !== undefined && !doc.u.includes(user)) {
          doc.u.push(user);
        }

        guardarDoc(editedDocId, doc);
        socket.to(editedDocId).emit("updateDocument", content);
      });

      socket.on("presenceProfile", (data) => {
        if (!data || data.docId !== docId || !rooms[docId]?.[socket.id]) return;
        const photo = typeof data.photo === "string" && data.photo.length < 180000
          ? data.photo
          : null;
        rooms[docId][socket.id].photo = photo;
        emitPresence(io, docId);
      });

      socket.on("cursorPosition", (data) => {
        if (!data || data.docId !== docId || !rooms[docId]?.[socket.id]) return;
        const position = Math.max(0, Number(data.position) || 0);
        socket.to(docId).emit("remoteCursorPosition", {
          socketId: socket.id,
          username: user,
          color: rooms[docId][socket.id].color,
          position,
          visible: data.visible !== false
        });
      });
    });

    socket.on("disconnect", () => {
      const docId = socket.data.activeDocId;
      if (!docId || !rooms[docId]) return;
      delete rooms[docId][socket.id];
      if (Object.keys(rooms[docId]).length === 0) delete rooms[docId];
      emitPresence(io, docId);
    });
  });
}
