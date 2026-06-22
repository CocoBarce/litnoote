import fs from "fs";

const docsPath = "./docs";

let rooms = {};

function cargarDoc(docId) {
  const file = docsPath + "/" + docId + ".json";
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
  const file = docsPath + "/" + docId + ".json";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

export function setupCollab(io) {
  io.on("connection", (socket) => {
    socket.on("unirse", (data) => {
      if (!data || !data.docId) return;

      const docId = data.docId;
      const user = data.user;
      socket.join(docId);
      if (user !== undefined) socket.user = user;

      if (!rooms[docId]) rooms[docId] = [];
      if (user !== undefined && !rooms[docId].includes(user)) {
        rooms[docId].push(user);
      }

      const doc = cargarDoc(docId);
      if (user !== undefined && !doc.u.includes(user)) {
        doc.u.push(user);
      }
      guardarDoc(docId, doc);

      socket.emit("loadDocument", doc.t || "");

      socket.on("editDocument", (data) => {
        if (!data || !data.docId) return;

        const docId = data.docId;
        const content = data.content || "";
        const user = data.user || socket.user;

        const doc = cargarDoc(docId);
        doc.t = content;
        if (!doc.u) doc.u = [];
        if (user !== undefined && !doc.u.includes(user)) {
          doc.u.push(user);
        }

        guardarDoc(docId, doc);
        socket.to(docId).emit("updateDocument", content);
        socket.emit("loadDocument", doc.t);
      });

      socket.on("salir", (arg1, arg2) => {
        let docId, user;
        if (arg1 && arg1.docId) {
          docId = arg1.docId;
          user = arg1.user;
        } else {
          docId = arg1;
          user = arg2;
        }
        if (!docId) return;
        if (user === undefined) user = socket.user;
        if (!user || !rooms[docId]) return;

        rooms[docId] = rooms[docId].filter(u => u !== user);
        if (rooms[docId].length === 0) delete rooms[docId];

        socket.leave(docId);
      });

      socket.on("disconnect", () => {
        const sUser = socket.user;
        if (!sUser) return;

        for (let docId in rooms) {
          rooms[docId] = rooms[docId].filter(u => u !== sUser);
          if (rooms[docId].length === 0) delete rooms[docId];
        }
      });
    });
  });
}
