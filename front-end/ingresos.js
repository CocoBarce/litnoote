const socket = io({ auth: { token: localStorage.getItem("sessionToken") || "" } });
socket.on('session-error', function() {
  localStorage.removeItem('sessionToken');
  localStorage.removeItem('userDEV');
  window.location.href = 'iniciosesion.html';
});

const btnentrada = document.getElementById('btn-rojo');
const roomInput  = document.getElementById('inputtt');
const documentList = document.getElementById('document-list-container');
const contextMenu = document.getElementById('doc-context-menu');

const user = localStorage.getItem('userDEV');
let allRooms    = [];
let sharedDocuments = [];
let pendingInvitations = [];
let serverFavs  = new Set();
let serverProfiles = [];
let serverQuizHistory = [];
let currentView = 'dashboard';
let serverXP = 0;
let serverLevel = { level: 1, name: 'Novato/a', xp: 0, xpNeeded: 300, xpPrev: 0 };
let serverStreak = 0;
let activeProfileId = null;

const key = function(k) { return k + '_' + user; };
const docTitle = function(doc) { return typeof doc === 'string' ? doc : doc.title; };
const docId = function(doc) { return typeof doc === 'string' ? doc : doc.id; };
const escapeHTML = function(value) {
  return String(value).replace(/[&<>"']/g, function(character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character];
  });
};

function openDocument(doc) {
  localStorage.setItem('docId', docId(doc));
  localStorage.setItem('docTitle', docTitle(doc));
  window.location.href = 'editor/sala.html';
}

function getSet(storageKey) {
  try { return new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); }
  catch(e) { return new Set(); }
}
function saveSet(storageKey, s) { localStorage.setItem(storageKey, JSON.stringify([...s])); }

function animateRemove(el, cb) {
  el.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
  el.style.opacity = '0';
  el.style.transform = 'translateX(-10px)';
  setTimeout(cb, 200);
}

function refreshCurrentDocumentView() {
  if (currentView === 'dashboard') renderRecentDocs();
  else renderDocs();
}

function closeDocumentContextMenu() {
  if (!contextMenu) return;
  contextMenu.classList.remove('open');
  contextMenu.setAttribute('aria-hidden', 'true');
  contextMenu.innerHTML = '';
}

function moveDocumentToTrash(currentDocId, item) {
  var deleted = getSet(key('deleted'));
  deleted.add(currentDocId);
  saveSet(key('deleted'), deleted);
  showToast('Documento movido a Eliminados');
  animateRemove(item, refreshCurrentDocumentView);
}

function restoreDocument(currentDocId, item) {
  var deleted = getSet(key('deleted'));
  deleted.delete(currentDocId);
  saveSet(key('deleted'), deleted);
  showToast('Documento restaurado');
  animateRemove(item, refreshCurrentDocumentView);
}

function permanentlyDeleteDocument(currentDocId, item) {
  var deleted = getSet(key('deleted'));
  var permanent = getSet(key('permanent'));
  deleted.delete(currentDocId);
  permanent.add(currentDocId);
  saveSet(key('deleted'), deleted);
  saveSet(key('permanent'), permanent);
  showToast('Documento eliminado definitivamente');
  animateRemove(item, refreshCurrentDocumentView);
}

function toggleDocumentFavorite(currentDocId, item, button) {
  var isFavorite = serverFavs.has(currentDocId);
  if (isFavorite) serverFavs.delete(currentDocId); else serverFavs.add(currentDocId);
  socket.emit('toggleFavorito', { user: user, docId: currentDocId });
  showToast(isFavorite ? 'Quitado de Favoritos' : 'Agregado a Favoritos');
  if (currentView === 'favorites') animateRemove(item, refreshCurrentDocumentView);
  else if (button) button.classList.toggle('active', !isFavorite);
}

function showDocumentContextMenu(event, doc, item) {
  if (!contextMenu) return;
  event.preventDefault();
  event.stopPropagation();
  var currentDocId = docId(doc);
  var currentTitle = docTitle(doc);
  var isDeleted = currentView === 'deleted';
  var isFavorite = serverFavs.has(currentDocId);

  contextMenu.innerHTML =
    '<div class="context-menu-title">' + escapeHTML(currentTitle) + '</div>' +
    (!isDeleted
      ? '<button class="context-menu-action" data-context-action="open" role="menuitem"><i class="fas fa-arrow-up-right-from-square"></i>Abrir documento</button>' +
        '<button class="context-menu-action" data-context-action="favorite" role="menuitem"><i class="fas fa-star"></i>' +
        (isFavorite ? 'Quitar de Favoritos' : 'Agregar a Favoritos') + '</button>' +
        '<div class="context-menu-separator"></div>' +
        '<button class="context-menu-action danger" data-context-action="trash" role="menuitem"><i class="fas fa-trash"></i>Mover a Eliminados</button>'
      : '<button class="context-menu-action" data-context-action="restore" role="menuitem"><i class="fas fa-undo"></i>Restaurar documento</button>' +
        '<div class="context-menu-separator"></div>' +
        '<button class="context-menu-action danger" data-context-action="permanent" role="menuitem"><i class="fas fa-trash-can"></i>Eliminar definitivamente</button>');

  contextMenu.onclick = function(clickEvent) {
    var actionButton = clickEvent.target.closest('[data-context-action]');
    if (!actionButton) return;
    closeDocumentContextMenu();
    switch (actionButton.dataset.contextAction) {
      case 'open': openDocument(doc); break;
      case 'favorite': toggleDocumentFavorite(currentDocId, item); break;
      case 'trash': moveDocumentToTrash(currentDocId, item); break;
      case 'restore': restoreDocument(currentDocId, item); break;
      case 'permanent': permanentlyDeleteDocument(currentDocId, item); break;
    }
  };
  positionContextMenu(event);
}

function positionContextMenu(event) {
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  contextMenu.classList.add('open');
  contextMenu.setAttribute('aria-hidden', 'false');
  var menuRect = contextMenu.getBoundingClientRect();
  var left = Math.min(event.clientX, window.innerWidth - menuRect.width - 10);
  var top = Math.min(event.clientY, window.innerHeight - menuRect.height - 10);
  contextMenu.style.left = Math.max(10, left) + 'px';
  contextMenu.style.top = Math.max(10, top) + 'px';
  contextMenu.querySelector('.context-menu-action')?.focus();
}

function showGlobalContextMenu(event) {
  if (!contextMenu || event.target.closest('.document-item, .recent-doc-item')) return;
  event.preventDefault();
  closeDocumentContextMenu();

  var input = event.target.closest('input, textarea, [contenteditable="true"]');
  var link = event.target.closest('a[href]');
  var sidebar = event.target.closest('.sidebar');
  var selection = window.getSelection && String(window.getSelection()).trim();
  var actions = [];

  if (input) {
    actions.push(
      ['copy', 'fa-copy', 'Copiar'],
      ['cut', 'fa-scissors', 'Cortar'],
      ['paste', 'fa-paste', 'Pegar'],
      ['select-all', 'fa-object-group', 'Seleccionar todo']
    );
  } else if (selection) {
    actions.push(['copy', 'fa-copy', 'Copiar texto']);
  }

  if (link) actions.push(['open-link', 'fa-arrow-up-right-from-square', 'Abrir enlace']);

  if (!input) {
    if (actions.length) actions.push(['separator']);
    actions.push(
      ['home', 'fa-house', 'Ir a Inicio'],
      ['documents', 'fa-file-lines', 'Ver Documentos'],
      ['favorites', 'fa-star', 'Ver Favoritos'],
      ['deleted', 'fa-trash', 'Ver Eliminados']
    );
    if (!sidebar) actions.push(['create', 'fa-plus', 'Crear documento']);
    actions.push(['refresh', 'fa-rotate-right', 'Actualizar página']);
  }

  contextMenu.innerHTML =
    '<div class="context-menu-title">Litnoote</div>' +
    actions.map(function(action) {
      if (action[0] === 'separator') return '<div class="context-menu-separator"></div>';
      return '<button class="context-menu-action" data-global-action="' + action[0] + '" role="menuitem">' +
        '<i class="fas ' + action[1] + '"></i>' + action[2] + '</button>';
    }).join('');

  contextMenu.onmousedown = function(mouseEvent) {
    if (mouseEvent.target.closest('.context-menu-action')) mouseEvent.preventDefault();
  };
  contextMenu.onclick = async function(clickEvent) {
    var button = clickEvent.target.closest('[data-global-action]');
    if (!button) return;
    var action = button.dataset.globalAction;
    closeDocumentContextMenu();
    try {
      if (action === 'copy') document.execCommand('copy');
      if (action === 'cut') document.execCommand('cut');
      if (action === 'paste') {
        var text = await navigator.clipboard.readText();
        if (input && 'value' in input) {
          var start = input.selectionStart || 0;
          var end = input.selectionEnd || 0;
          input.setRangeText(text, start, end, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (action === 'select-all') {
        input.focus();
        if (typeof input.select === 'function') {
          input.select();
        } else if (input.isContentEditable) {
          var range = document.createRange();
          range.selectNodeContents(input);
          var selected = window.getSelection();
          selected.removeAllRanges();
          selected.addRange(range);
        }
      }
      if (action === 'open-link') window.location.href = link.href;
      if (action === 'home') window.setView('dashboard');
      if (action === 'documents') window.setView('all');
      if (action === 'favorites') window.setView('favorites');
      if (action === 'deleted') window.setView('deleted');
      if (action === 'create') document.getElementById('btn-crear')?.click();
      if (action === 'refresh') window.location.reload();
    } catch {
      showToast('El navegador no permitió esa acción', 'error');
    }
  };
  positionContextMenu(event);
}

document.addEventListener('click', closeDocumentContextMenu);
document.addEventListener('contextmenu', showGlobalContextMenu);
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') closeDocumentContextMenu();
});
window.addEventListener('blur', closeDocumentContextMenu);
window.addEventListener('resize', closeDocumentContextMenu);
document.addEventListener('scroll', closeDocumentContextMenu, true);

function closeCreatePanel() {
  var panel = document.getElementById('crear-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.setAttribute('aria-hidden', 'true');
  }
  if (roomInput) roomInput.value = '';
}

// ── Level/XP UI update ────────────────────────────────────────
function updateXPUI(xp, level, streak) {
  serverXP = xp;
  serverLevel = level;
  serverStreak = streak;

  var pct = Math.round(((xp - level.xpPrev) / (level.xpNeeded - level.xpPrev)) * 100);
  if (isNaN(pct) || pct < 0) pct = 0;
  if (pct > 100) pct = 100;

  // XP banner
  var levelNumEl = document.getElementById('xp-level-num');
  var levelNameEl = document.getElementById('xp-level-name');
  var barFillEl = document.getElementById('xp-bar-fill');
  var barLabelEl = document.getElementById('xp-bar-label');
  var totalStatEl = document.getElementById('xp-total-stat');
  var streakStatEl = document.getElementById('streak-stat');
  var quizStatEl = document.getElementById('quiz-stat');

  if (levelNumEl) levelNumEl.textContent = level.level;
  if (levelNameEl) levelNameEl.textContent = 'Nivel ' + level.level + ' \u00B7 ' + level.name;
  if (barFillEl) barFillEl.style.width = pct + '%';
  if (barLabelEl) barLabelEl.textContent = xp.toLocaleString('es-AR') + ' / ' + level.xpNeeded.toLocaleString('es-AR') + ' XP';
  if (totalStatEl) totalStatEl.textContent = xp.toLocaleString('es-AR');
  if (streakStatEl) streakStatEl.textContent = streak;
  if (quizStatEl) quizStatEl.textContent = serverQuizHistory.length;

  // Sidebar XP bar
  var sidebarLevelEl = document.getElementById('sidebar-level-label');
  var sidebarXPCountEl = document.getElementById('sidebar-xp-count');
  var sidebarFillEl = document.getElementById('sidebar-xp-fill');

  if (sidebarLevelEl) sidebarLevelEl.textContent = 'Nv. ' + level.level + ' \u00B7 ' + level.name;
  if (sidebarXPCountEl) sidebarXPCountEl.textContent = xp.toLocaleString('es-AR') + ' XP';
  if (sidebarFillEl) sidebarFillEl.style.width = pct + '%';

  // Popup stats
  var popupXPEl = document.getElementById('popup-xp');
  var popupStreakEl = document.getElementById('popup-streak');
  var popupProfilesEl = document.getElementById('popup-profiles');

  if (popupXPEl) popupXPEl.textContent = xp.toLocaleString('es-AR') + ' XP';
  if (popupStreakEl) popupStreakEl.textContent = streak;
  if (popupProfilesEl) popupProfilesEl.textContent = serverProfiles.length;
}

// ── Render profiles ──────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  var diff = Math.ceil((new Date(dateStr) - Date.now()) / 86400000);
  return diff;
}

function renderProfiles(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (serverProfiles.length === 0) {
    container.innerHTML =
      '<div class="empty-profiles">' +
      '<i class="fas fa-layer-group"></i>' +
      '<p>Sin perfiles aun</p>' +
      '<span>Crea tu primer perfil para organizar tu estudio</span>' +
      '</div>';
    return;
  }

  serverProfiles.forEach(function(profile) {
    var card = document.createElement('div');
    card.className = 'profile-card';

    var days = daysUntil(profile.examDate);
    var countdownHtml = (days !== null && days >= 0)
      ? '<span class="profile-countdown"><i class="fas fa-clock"></i>' + days + ' dias</span>'
      : '';

    var domainPct = profile.domain || 0;
    var scoreHtml = profile.lastQuizScore
      ? '<span class="badge-score">' + profile.lastQuizScore + '</span><span class="badge-xp">+' + profile.lastQuizXP + ' XP</span>'
      : '<span style="color:var(--t3);font-size:11px">Sin quizzes aun</span>';

    var docCount = (profile.docs || []).length;
    var noteProgress = profile.summaryProgress || 0;

    card.innerHTML =
      '<button class="profile-card-del" data-id="' + profile.id + '" title="Eliminar perfil"><i class="fas fa-times"></i></button>' +
      '<div class="profile-card-top">' +
      '<span class="profile-materia-dot" style="background:' + profile.color + '"></span>' +
      '<span class="profile-materia-label" style="color:' + profile.color + '">' + (profile.materia || 'Sin materia') + '</span>' +
      countdownHtml +
      '</div>' +
      '<div class="profile-card-name">' + profile.nombre + '</div>' +
      '<div class="profile-card-sub">' + docCount + ' apunte' + (docCount !== 1 ? 's' : '') + '</div>' +
      '<div class="profile-note-progress">' + noteProgress + '% del objetivo de apuntes</div>' +
      '<div class="profile-domain-bar">' +
      '<div class="profile-domain-fill" style="width:' + domainPct + '%;background:' + profile.color + '"></div>' +
      '</div>' +
      '<div class="profile-card-footer">' +
      scoreHtml +
      '<span class="badge-domain">' + domainPct + '%</span>' +
      '</div>';

    card.querySelector('.profile-card-del').addEventListener('click', function(e) {
      e.stopPropagation();
      socket.emit('eliminarPerfil', { user: user, profileId: profile.id });
    });

    card.addEventListener('click', function(e) {
      if (e.target.closest('.profile-card-del')) return;
      localStorage.setItem('currentProfile', profile.id);
      window.setView('all', profile.id);
    });

    container.appendChild(card);
  });
}

// ── Render recent docs ────────────────────────────────────────
function renderRecentDocs() {
  var container = document.getElementById('recent-docs');
  if (!container) return;
  var deleted = getSet(key('deleted'));
  var permanent = getSet(key('permanent'));
  var recent = allRooms
    .filter(function(doc) { return !deleted.has(docId(doc)) && !permanent.has(docId(doc)); })
    .slice(-5)
    .reverse();

  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-file-alt"></i><p>Sin documentos recientes</p><span>Crea tu primer documento</span></div>';
    return;
  }

  container.innerHTML = '';
  recent.forEach(function(doc) {
    var item = document.createElement('div');
    item.className = 'recent-doc-item';
    item.innerHTML =
      '<i class="fas fa-file-alt recent-doc-icon"></i>' +
      '<span class="recent-doc-name">' + docTitle(doc) + '</span>' +
      '<i class="fas fa-chevron-right recent-doc-arrow"></i>';
    item.addEventListener('click', function() {
      openDocument(doc);
    });
    item.addEventListener('contextmenu', function(event) {
      showDocumentContextMenu(event, doc, item);
    });
    container.appendChild(item);
  });
}

// ── Render document list (existing views) ─────────────────────
function renderDocs() {
  var deleted   = getSet(key('deleted'));
  var permanent = getSet(key('permanent'));
  var available = allRooms.filter(function(doc) { return !permanent.has(docId(doc)); });
  if (activeProfileId) {
    var activeProfile = serverProfiles.find(function(profile) { return profile.id === activeProfileId; });
    available = activeProfile ? available.filter(function(doc) {
      return (activeProfile.docs || []).indexOf(docId(doc)) !== -1;
    }) : [];
  }

  var rooms;
  if (currentView === 'favorites') {
    rooms = available.filter(function(doc) { return serverFavs.has(docId(doc)) && !deleted.has(docId(doc)); });
  } else if (currentView === 'deleted') {
    rooms = available.filter(function(doc) { return deleted.has(docId(doc)); });
  } else {
    rooms = available.filter(function(doc) { return !deleted.has(docId(doc)); });
  }

  documentList.innerHTML = '';

  if (rooms.length === 0) {
    var states = {
      all:       { icon: 'fa-file-alt',  title: 'Sin documentos aun',   sub: 'Hace clic en "Crear" para empezar' },
      favorites: { icon: 'fa-star',      title: 'Sin favoritos',         sub: 'Marca documentos con la estrella para verlos aca' },
      deleted:   { icon: 'fa-trash-alt', title: 'Papelera vacia',        sub: 'Los documentos eliminados aparecen aca' },
    };
    var e = states[currentView] || states.all;
    documentList.innerHTML = '<div class="empty-state"><i class="fas ' + e.icon + '"></i><p>' + e.title + '</p><span>' + e.sub + '</span></div>';
    return;
  }

  rooms.forEach(function(doc) {
    var currentDocId = docId(doc);
    var currentTitle = docTitle(doc);
    var item = document.createElement('div');
    item.classList.add('document-item');
    item.dataset.docid = currentDocId;
    item.dataset.title = currentTitle;
    var isFav = serverFavs.has(currentDocId);

    if (currentView === 'deleted') {
      item.classList.add('is-deleted');
      item.innerHTML =
        '<span class="doc-name"><i class="fas fa-file-alt" style="margin-right:10px;color:#34C7A9;font-size:13px;"></i>' + currentTitle + '</span>' +
        '<div class="icons">' +
        '<i class="fas fa-undo  doc-action" data-action="restore"     title="Restaurar"></i>' +
        '<i class="fas fa-times doc-action" data-action="perm-delete" title="Eliminar permanentemente"></i>' +
        '</div>';
    } else {
      var secondaryAction = activeProfileId
        ? '<button type="button" class="doc-action doc-action-button" data-action="unlink-profile" title="Sacar del perfil" aria-label="Sacar del perfil">' +
          '<i class="fas fa-link-slash" aria-hidden="true"></i><span>Sacar</span></button>'
        : '<button type="button" class="doc-action doc-action-button danger" data-action="trash" title="Mover a eliminados" aria-label="Borrar documento">' +
          '<i class="fas fa-trash" aria-hidden="true"></i><span>Borrar</span></button>';
      item.innerHTML =
        '<span class="doc-name"><i class="fas fa-file-alt" style="margin-right:10px;color:#34C7A9;font-size:13px;"></i>' + currentTitle + '</span>' +
        '<div class="icons">' +
        '<button type="button" class="doc-action doc-action-button favorite ' + (isFav ? 'active' : '') + '" data-action="star" title="Favorito" aria-label="Marcar como favorito">' +
        '<i class="fas fa-star" aria-hidden="true"></i><span>Favorito</span></button>' +
        secondaryAction +
        '</div>';
    }

    item.querySelector('.icons').addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('.doc-action');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'star': {
          toggleDocumentFavorite(currentDocId, item, btn);
          break;
        }
        case 'trash': { moveDocumentToTrash(currentDocId, item); break; }
        case 'unlink-profile': {
          socket.emit('assignDocToPerfil', { user: user, docId: currentDocId, profileId: null });
          animateRemove(item, renderDocs);
          break;
        }
        case 'restore': { restoreDocument(currentDocId, item); break; }
        case 'perm-delete': {
          permanentlyDeleteDocument(currentDocId, item);
          break;
        }
      }
    });

    item.addEventListener('click', function(e) {
      if (e.target.closest('.icons') || currentView === 'deleted') return;
      openDocument(doc);
    });
    item.addEventListener('contextmenu', function(event) {
      showDocumentContextMenu(event, doc, item);
    });

    documentList.appendChild(item);
  });
}

// ── View switching ────────────────────────────────────────────
window.setView = function(view, profileId) {
  currentView = view;
  activeProfileId = profileId || null;
  if (view === 'all' && !profileId) localStorage.removeItem('currentProfile');

  document.querySelectorAll('.menu li').forEach(function(li) { li.classList.remove('active'); });
  var map = { dashboard: 'btn-inicio', all: 'btn-doc', favorites: 'btn-fav', deleted: 'btn-del', perfiles: 'btn-perfiles', quizzes: 'btn-quizzes', shared: 'btn-shared' };
  if (map[view]) {
    var el = document.getElementById(map[view]);
    if (el) el.classList.add('active');
  }

  var dashView = document.getElementById('view-dashboard');
  var perfilesView = document.getElementById('view-perfiles');
  var docsView = document.getElementById('view-docs');
  var quizzesView = document.getElementById('view-quizzes');
  var sharedView = document.getElementById('view-shared');

  if (dashView) dashView.style.display = (view === 'dashboard') ? '' : 'none';
  if (perfilesView) perfilesView.style.display = (view === 'perfiles') ? '' : 'none';
  if (docsView) docsView.style.display = (['all','favorites','deleted'].indexOf(view) !== -1) ? '' : 'none';
  if (quizzesView) quizzesView.style.display = (view === 'quizzes') ? '' : 'none';
  if (sharedView) sharedView.style.display = (view === 'shared') ? '' : 'none';

  var docTitle = document.getElementById('section-title-docs');
  if (docTitle) {
    var titles = { all: 'Documentos', favorites: 'Favoritos', deleted: 'Eliminados' };
    var selectedProfile = activeProfileId && serverProfiles.find(function(profile) { return profile.id === activeProfileId; });
    docTitle.textContent = selectedProfile ? selectedProfile.nombre : (titles[view] || 'Documentos');
  }

  if (['all','favorites','deleted'].indexOf(view) !== -1) renderDocs();
  if (view === 'perfiles') renderProfiles('profiles-grid-view');
  if (view === 'dashboard') { renderProfiles('profiles-grid-dash'); renderRecentDocs(); }
  if (view === 'quizzes') renderQuizHistory();
  if (view === 'shared') renderSharedDocuments();
};

function renderSharedDocuments() {
  var invitations = document.getElementById('pending-invitations');
  var list = document.getElementById('shared-document-list');
  if (!invitations || !list) return;

  invitations.innerHTML = '';
  pendingInvitations.forEach(function(invitation) {
    var card = document.createElement('div');
    card.className = 'invitation-card';
    card.innerHTML =
      '<div class="invitation-icon"><i class="fas fa-envelope-open-text"></i></div>' +
      '<div class="invitation-copy"><strong>' + invitation.title + '</strong><span>' + invitation.owner + ' te invitó a colaborar</span></div>' +
      '<div class="invitation-actions"><button data-answer="accept">Aceptar</button><button class="secondary" data-answer="reject">Rechazar</button></div>';
    card.querySelector('[data-answer="accept"]').addEventListener('click', function() {
      socket.emit('responderInvitacion', { user: user, docId: invitation.id, accept: true });
    });
    card.querySelector('[data-answer="reject"]').addEventListener('click', function() {
      socket.emit('responderInvitacion', { user: user, docId: invitation.id, accept: false });
    });
    invitations.appendChild(card);
  });

  list.innerHTML = '';
  if (!sharedDocuments.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-user-group"></i><p>Sin documentos compartidos</p><span>Las invitaciones aceptadas aparecerán acá</span></div>';
    return;
  }
  sharedDocuments.forEach(function(doc) {
    var item = document.createElement('div');
    item.className = 'document-item shared-document-item';
    item.innerHTML =
      '<span class="doc-name"><i class="fas fa-file-alt"></i><span><strong>' + doc.title + '</strong><small>Propietario: ' + doc.owner + '</small></span></span>' +
      '<div class="icons"><button class="leave-shared" title="Dejar de colaborar"><i class="fas fa-right-from-bracket"></i></button></div>';
    item.querySelector('.leave-shared').addEventListener('click', function(e) {
      e.stopPropagation();
      socket.emit('abandonarCompartido', { user: user, docId: doc.id });
    });
    item.addEventListener('click', function(e) {
      if (!e.target.closest('.icons')) openDocument(doc);
    });
    list.appendChild(item);
  });
}

function renderQuizHistory() {
  var container = document.getElementById('quiz-history-list');
  if (!container) return;
  if (!serverQuizHistory.length) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-circle-question"></i><p>Sin quizzes todavia</p><span>Completa uno desde un documento para verlo aca</span></div>';
    return;
  }
  container.innerHTML = '';
  serverQuizHistory.slice().reverse().forEach(function(result) {
    var profile = serverProfiles.find(function(item) { return item.id === result.profileId; });
    var relatedDocument = allRooms.concat(sharedDocuments).find(function(doc) { return doc.id === result.docId; });
    var pct = Math.round((result.score / result.total) * 100);
    var row = document.createElement('div');
    row.className = 'quiz-history-item';
    row.innerHTML =
      '<div class="quiz-history-score">' + result.score + '/' + result.total + '</div>' +
      '<div class="quiz-history-main"><strong>' + (relatedDocument ? relatedDocument.title : 'Quiz de estudio') + '</strong>' +
      '<span>' + (profile ? profile.nombre : 'Sin perfil') + ' · ' + (result.mode || 'normal') + '</span></div>' +
      '<div class="quiz-history-meta"><strong>' + pct + '%</strong><span>+' + result.xpEarned + ' XP · ' + (result.date || '') + '</span></div>';
    container.appendChild(row);
  });
}

// ── Socket events ─────────────────────────────────────────────
socket.emit('cargarNORMAL', { user: user });

socket.on('cargar1', function(data) {
  if (!data) return;
  allRooms        = data.rooms     || [];
  sharedDocuments = data.sharedDocuments || [];
  pendingInvitations = data.pendingInvitations || [];
  serverFavs      = new Set(data.favoritos || []);
  serverProfiles  = data.profiles  || [];
  serverQuizHistory = data.quizHistory || [];
  var inviteCount = document.getElementById('invite-count');
  if (inviteCount) {
    inviteCount.textContent = pendingInvitations.length;
    inviteCount.style.display = pendingInvitations.length ? '' : 'none';
  }

  updateXPUI(
    data.xp || 0,
    data.level || { level: 1, name: 'Novato/a', xp: 0, xpNeeded: 300, xpPrev: 0 },
    data.streak || 0
  );

  window.setView('dashboard');
  var initBtn = document.getElementById('btn-inicio');
  if (initBtn) initBtn.classList.add('active');
});

socket.on('perfilCreado', function(data) {
  serverProfiles.push(data.profile);
  updateXPUI(data.xp, data.level, serverStreak);
  showXPToast(data.xpGained, 'perfil creado');
  closeNuevoPerfilModal();
  renderProfiles('profiles-grid-dash');
  renderProfiles('profiles-grid-view');
  var popupProfilesEl = document.getElementById('popup-profiles');
  if (popupProfilesEl) popupProfilesEl.textContent = serverProfiles.length;
});

socket.on('perfilEliminado', function(data) {
  serverProfiles = serverProfiles.filter(function(p) { return p.id !== data.profileId; });
  renderProfiles('profiles-grid-dash');
  renderProfiles('profiles-grid-view');
});

socket.on('docPerfilAsignado', function(data) {
  serverProfiles = data.profiles || serverProfiles;
  renderProfiles('profiles-grid-dash');
  renderProfiles('profiles-grid-view');
  if (activeProfileId && !data.profileId) {
    showToast('Apunte sacado del perfil');
  }
});

socket.on('xpAwarded', function(data) {
  updateXPUI(data.xp, data.level, serverStreak);
  showXPToast(data.xpEarned, 'escribir hoy');
});

socket.on('invitacionRespondida', function() {
  socket.emit('cargarNORMAL', { user: user });
  window.setView('shared');
});

socket.on('compartidoAbandonado', function(data) {
  sharedDocuments = sharedDocuments.filter(function(doc) { return doc.id !== data.docId; });
  renderSharedDocuments();
});

socket.on('invitacionesCambiaron', function() {
  socket.emit('cargarNORMAL', { user: user });
});

socket.on('documentoCreado', function(data) {
  allRooms.push(data.document);
  closeCreatePanel();
  openDocument(data.document);
});

socket.on('documentoError', function(data) {
  showToast(data.mensaje, 'error');
});

// ── Create profile form ───────────────────────────────────────
document.getElementById('btn-crear-perfil').addEventListener('click', function() {
  var nombre = document.getElementById('perfil-nombre').value.trim();
  if (!nombre) { document.getElementById('perfil-nombre').focus(); return; }
  var materia = document.getElementById('perfil-materia').value.trim();
  var examDate = document.getElementById('perfil-fecha').value || null;
  socket.emit('crearPerfil', { user: user, nombre: nombre, materia: materia, color: selectedColor, examDate: examDate });
});

// ── Create/open document ──────────────────────────────────────
function envio() {
  var title = roomInput.value.trim();
  if (!title) { roomInput.focus(); return; }
  socket.emit('crearDocumento', { user: user, title: title });
}
if (btnentrada) btnentrada.addEventListener('click', envio);
if (roomInput) roomInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') envio(); });
