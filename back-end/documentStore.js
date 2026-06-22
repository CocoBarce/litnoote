import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCUMENTS_FILE = path.join(__dirname, "documentos.json");
const USERS_FILE = path.join(__dirname, "usuarios.json");
const DOCS_DIR = path.join(__dirname, "docs");
fs.mkdirSync(DOCS_DIR, { recursive: true });

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readDocuments() {
  return readJson(DOCUMENTS_FILE, {});
}

export function writeDocuments(data) {
  writeJson(DOCUMENTS_FILE, data);
}

export function createDocumentId() {
  return `doc_${crypto.randomUUID()}`;
}

export function documentFile(docId) {
  return path.join(DOCS_DIR, `${docId}.json`);
}

export function canAccessDocument(document, username) {
  return Boolean(document && username && (
    document.owner === username || (document.collaborators || []).includes(username)
  ));
}

export function serializeDocument(document, username) {
  return {
    id: document.id,
    title: document.title,
    owner: document.owner,
    role: document.owner === username ? "owner" : "collaborator",
    collaborators: document.collaborators || [],
    createdAt: document.createdAt
  };
}

export function migrateLegacyDocuments() {
  const users = readJson(USERS_FILE, {});
  const existing = readDocuments();
  if (Object.keys(existing).length > 0) return;

  const legacyNames = new Set();
  Object.values(users).forEach(user => (user.rooms || []).forEach(name => legacyNames.add(name)));

  const documents = {};
  const titleToId = {};
  for (const title of legacyNames) {
    const members = Object.values(users)
      .filter(user => (user.rooms || []).includes(title))
      .sort((a, b) => (a.id || 0) - (b.id || 0))
      .map(user => user.username);
    if (!members.length) continue;

    const id = createDocumentId();
    titleToId[title] = id;
    documents[id] = {
      id,
      title,
      owner: members[0],
      collaborators: members.slice(1),
      pendingInvites: [],
      createdAt: new Date().toISOString(),
      migratedFrom: title
    };

    const oldFile = path.join(DOCS_DIR, `${title}.json`);
    const newFile = documentFile(id);
    if (fs.existsSync(oldFile)) fs.copyFileSync(oldFile, newFile);
    else writeJson(newFile, { t: "", u: members });
  }

  Object.values(users).forEach(user => {
    const ids = (user.rooms || []).map(name => titleToId[name]).filter(Boolean);
    user.rooms = ids.filter(id => documents[id].owner === user.username);
    user.sharedRooms = ids.filter(id => documents[id].owner !== user.username);
    user.favoritos = (user.favoritos || []).map(name => titleToId[name]).filter(Boolean);
    (user.profiles || []).forEach(profile => {
      profile.docs = (profile.docs || []).map(name => titleToId[name]).filter(Boolean);
    });
    (user.quizHistory || []).forEach(result => {
      result.docId = titleToId[result.docId] || result.docId;
    });
    if (user.noteStats) {
      const nextStats = {};
      Object.entries(user.noteStats).forEach(([name, stats]) => {
        nextStats[titleToId[name] || name] = stats;
      });
      user.noteStats = nextStats;
    }
  });

  writeDocuments(documents);
  writeJson(USERS_FILE, users);
  console.log(`Migración completada: ${Object.keys(documents).length} documentos con ID único.`);
}
