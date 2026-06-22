const socket = io({ auth: { token: localStorage.getItem("sessionToken") || "" } });
socket.on("session-error", () => {
  localStorage.removeItem("sessionToken");
  localStorage.removeItem("userDEV");
  window.location.href = "iniciosesion.html";
});
const user = localStorage.getItem("userDEV");
const emailInput = document.getElementById("account-email");
const feedback = document.getElementById("email-feedback");

socket.emit("cargarCuenta", { user });
socket.on("cuentaData", data => { emailInput.value = data.email || ""; });

document.getElementById("save-email").addEventListener("click", () => {
  socket.emit("actualizarEmail", { user, email: emailInput.value.trim() });
});

socket.on("emailActualizado", data => {
  feedback.textContent = data.mensaje;
  feedback.className = data.ok ? "ok" : "error";
});
