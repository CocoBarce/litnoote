const socket = io();

function showToast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    requestAnimationFrame(() => { t.classList.add('show'); });
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.classList.remove('show'); }, 3200);
}

const formu = document.getElementById("register");
const btn = document.getElementById("registerbtn");

formu.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = document.getElementById("password").value;
    const password2 = document.getElementById("password2").value;
    const user = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();

    if (!user || !email || !password) return;

    if (password !== password2) {
        showToast("Las contraseñas no coinciden", 'error');
        return;
    }

    btn.disabled = true;
    btn.textContent = "Creando cuenta...";
    socket.emit("registro", { user, email, password });
});

socket.on("registro-exito", (data) => {
    showToast(data.mensaje);
    btn.textContent = "Cuenta creada";
    setTimeout(() => { window.location.href = "iniciosesion.html"; }, 1400);
});

socket.on("registro-error", (data) => {
    showToast(data.mensaje, 'error');
    btn.disabled = false;
    btn.textContent = "Crear cuenta";
});
