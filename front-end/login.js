const socket = io();

function showToast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    requestAnimationFrame(() => { t.classList.add('show'); });
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.classList.remove('show'); }, 3200);
}

const formu = document.getElementById("form");
const btn = document.getElementById("sesionbtn");

formu.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = document.getElementById("password").value;
    const user = document.getElementById("user").value.trim();
    if (!user || !password) return;
    btn.disabled = true;
    btn.textContent = "Ingresando...";
    socket.emit("login", { user, password });
});

socket.on("login-exito", (data) => {
    localStorage.setItem("sessionToken", data.token);
    localStorage.setItem("userDEV", data.username);
    showToast(data.mensaje);
    setTimeout(() => { window.location.href = "document.html"; }, 800);
});

socket.on("userDEV", (data) => {
    localStorage.setItem("userDEV", data);
});

socket.on("login-error", (data) => {
    showToast(data.mensaje, 'error');
    btn.disabled = false;
    btn.textContent = "Continuar";
});
