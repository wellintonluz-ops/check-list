const storageKey = 'checklist-app-v1';
const historyKey = 'checklist-history-v1';

const $subjects = document.getElementById('subjects');
const $form = document.getElementById('subject-form');
const $imageInput = document.getElementById('image-input');
const $saveDay = document.getElementById('save-day');
const $loginBtn = document.getElementById('login-btn');
const $logoutBtn = document.getElementById('logout-btn');
const $loginForm = document.getElementById('login-form');
const $loginUser = document.getElementById('login-user');
const $loginPass = document.getElementById('login-pass');
const $loginStatus = document.getElementById('login-status');
const $loginPanel = document.getElementById('login-panel');
const $createSection = document.getElementById('create-section');
const $tabButtons = document.querySelectorAll('[data-tab]');
const $tabPanels = document.querySelectorAll('[data-panel]');
const $historyList = document.getElementById('history-list');
const $historyEmpty = document.getElementById('history-empty');
const $imageModal = document.getElementById('image-modal');
const $imageModalImg = document.getElementById('image-modal-img');
const $imageModalClose = document.getElementById('image-modal-close');
const $syncStatus = document.getElementById('sync-status');

const firebaseConfig = {
  apiKey: 'AIzaSyCQ-ggnG6xU-I51DkWwhzwyXrUTsWTzpbU',
  authDomain: 'check-list-a8af4.firebaseapp.com',
  projectId: 'check-list-a8af4',
  storageBucket: 'check-list-a8af4.firebasestorage.app',
  messagingSenderId: '569484320290',
  appId: '1:569484320290:web:014218d2a7093df399b47b',
  measurementId: 'G-7MNT6RMEHG',
};

const FIRESTORE_COLLECTION = 'checklistSnapshots';
const FIRESTORE_STATE_COLLECTION = 'checklistState';
const FIRESTORE_STATE_DOC = 'shared';
let firestoreDb = null;
let isFirestoreReady = false;
let anonAuthPromise = null;
let unsubscribeState = null;
let unsubscribeHistory = null;

const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const authKey = 'checklist-auth-v1';
let isLoggedIn = false;

const setSyncStatus = (text, state = 'syncing') => {
  if (!$syncStatus) return;
  $syncStatus.textContent = text;
  $syncStatus.dataset.state = state;
};

const debounce = (fn, delay = 400) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
};

// Placeholder to avoid undefined before debounce is attached
let persistStateToFirestoreDebounced = () => Promise.resolve();

const ensureStorage = async () => {
  const db = await initFirestore();
  if (!db || typeof firebase === 'undefined' || !firebase.storage) return null;
  return firebase.storage();
};

const uploadImageToStorage = async (file, subjectId, topicId) => {
  const storage = await ensureStorage();
  if (!storage) throw new Error('Storage indisponível');
  const path = `topics/${subjectId}/${topicId}-${Date.now()}`;
  const ref = storage.ref().child(path);
  await ref.put(file);
  return ref.getDownloadURL();
};

const stripImages = (subjects) =>
  (subjects || []).map((subject) => ({
    ...subject,
    topics: (subject.topics || []).map((t) => {
      const { image, imageUrl, ...rest } = t;
      return { ...rest, hasImage: !!(imageUrl || image), imageUrl: imageUrl || null };
    }),
  }));

const mergeRemoteWithLocalImages = (remoteSubjects, localSubjects) =>
  (remoteSubjects || []).map((remoteSubject) => {
    const localSubject = (localSubjects || []).find((s) => s.id === remoteSubject.id);
    return {
      ...remoteSubject,
      topics: (remoteSubject.topics || []).map((rt) => {
        const localTopic = localSubject?.topics?.find((t) => t.id === rt.id);
        return { ...rt, image: localTopic?.image, imageUrl: localTopic?.imageUrl || rt.imageUrl || null };
      }),
    };
  });

const normalizeState = (items) => {
  if (!Array.isArray(items)) return [];
  return items.map((subject) => ({
    id: subject.id || uid(),
    title: subject.title || 'Assunto',
    topics: Array.isArray(subject.topics)
      ? subject.topics.map((t) => ({ id: t.id || uid(), text: t.text || 'Tópico', done: !!t.done, image: t.image, imageUrl: t.imageUrl || null }))
      : [],
  }));
};

const defaults = () => ([
  {
    id: uid(),
    title: 'Viagem',
    topics: [
      { id: uid(), text: 'Passagens emitidas', done: true },
      { id: uid(), text: 'Reserva de hospedagem', done: false },
      { id: uid(), text: 'Seguro viagem', done: false },
      { id: uid(), text: 'Roteiro diário', done: true },
    ],
  },
  {
    id: uid(),
    title: 'Projeto',
    topics: [
      { id: uid(), text: 'Definir escopo', done: true },
      { id: uid(), text: 'Montar cronograma', done: false },
      { id: uid(), text: 'Checklist de riscos', done: false },
    ],
  },
]);

const load = () => {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return defaults();
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return defaults();
    return parsed;
  } catch (err) {
    console.warn('Falha ao carregar, usando dados padrão', err);
    return defaults();
  }
};

const save = () => {
  localStorage.setItem(storageKey, JSON.stringify(state));
  const persistFn = typeof persistStateToFirestoreDebounced === 'function' ? persistStateToFirestoreDebounced : null;
  if (persistFn) {
    Promise.resolve(persistFn()).catch((err) => console.warn('Falha ao salvar estado no Firestore', err));
  }
};
const saveHistory = () => localStorage.setItem(historyKey, JSON.stringify(history));
const saveAuth = () => localStorage.setItem(authKey, isLoggedIn ? '1' : '0');

const loadHistory = () => {
  try {
    const saved = localStorage.getItem(historyKey);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((snap) => ({
        id: snap.id || uid(),
        savedAt: snap.savedAt || new Date().toISOString(),
        subjects: normalizeState(snap.subjects),
      }))
      .filter(Boolean);
  } catch (err) {
    console.warn('Falha ao carregar histórico', err);
    return [];
  }
};

const ensureAnonAuth = async () => {
  if (typeof firebase === 'undefined' || !firebase.auth) return null;
  if (firebase.auth().currentUser) return firebase.auth().currentUser;
  if (!anonAuthPromise) {
    anonAuthPromise = firebase
      .auth()
      .signInAnonymously()
      .catch((err) => {
        console.warn('Falha no login anônimo para Firestore', err);
        anonAuthPromise = null;
        return null;
      });
  }
  return anonAuthPromise;
};

const initFirestore = async () => {
  if (typeof firebase === 'undefined') return null;
  if (isFirestoreReady && firestoreDb) return firestoreDb;
  try {
    if (!firebase.apps?.length) firebase.initializeApp(firebaseConfig);
    await ensureAnonAuth();
    firestoreDb = firebase.firestore();
    isFirestoreReady = true;
    return firestoreDb;
  } catch (err) {
    console.warn('Não foi possível iniciar o Firestore', err);
    return null;
  }
};

const fetchHistoryFromFirestore = async () => {
  try {
    const db = await initFirestore();
    if (!db) return;
    const snap = await db.collection(FIRESTORE_COLLECTION).orderBy('savedAt', 'desc').limit(50).get();
    const remoteHistory = snap.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        savedAt: data.savedAt || new Date().toISOString(),
        subjects: normalizeState(data.subjects),
        justification: data.justification || null,
        pending: Array.isArray(data.pending) ? data.pending : [],
      };
    });
    if (!remoteHistory.length) return;

    const merged = [...remoteHistory];
    history.forEach((item) => {
      if (!merged.find((r) => r.id === item.id)) merged.push(item);
    });
    history = merged.slice(0, 50);
    saveHistory();
    if (activeTab === 'history') renderHistory();
    setSyncStatus('Histórico carregado da nuvem', 'online');
  } catch (err) {
    console.warn('Falha ao carregar histórico do Firestore', err);
    setSyncStatus('Erro ao carregar histórico', 'error');
  }
};

const persistSnapshotToFirestore = async (snapshot) => {
  try {
    const db = await initFirestore();
    if (!db) return;
    const payload = {
      ...snapshot,
      subjects: stripImages(snapshot.subjects),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection(FIRESTORE_COLLECTION).doc(snapshot.id).set(payload);
  } catch (err) {
    console.warn('Falha ao salvar no Firestore', err);
  }
};

const persistStateToFirestore = async () => {
  try {
    const db = await initFirestore();
    if (!db) return;
    const payload = {
      subjects: stripImages(state),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection(FIRESTORE_STATE_COLLECTION).doc(FIRESTORE_STATE_DOC).set(payload, { merge: true });
    setSyncStatus('Estado salvo na nuvem', 'online');
  } catch (err) {
    console.warn('Falha ao salvar estado no Firestore', err);
    setSyncStatus('Erro ao salvar na nuvem', 'error');
  }
};

persistStateToFirestoreDebounced = debounce(persistStateToFirestore, 350);

const fetchStateFromFirestore = async () => {
  try {
    const db = await initFirestore();
    if (!db) return;
    const doc = await db.collection(FIRESTORE_STATE_COLLECTION).doc(FIRESTORE_STATE_DOC).get();
    if (!doc.exists) return;
    const data = doc.data() || {};
    const remoteSubjects = normalizeState(data.subjects || []);
    if (!remoteSubjects.length) return;
    state = mergeRemoteWithLocalImages(remoteSubjects, state);
    save();
    render();
    setSyncStatus('Estado atualizado da nuvem', 'online');
  } catch (err) {
    console.warn('Falha ao carregar estado do Firestore', err);
    setSyncStatus('Erro ao atualizar da nuvem', 'error');
  }
};

const subscribeStateFromFirestore = async () => {
  try {
    const db = await initFirestore();
    if (!db) return;
    if (unsubscribeState) return; // já inscrito
    unsubscribeState = db
      .collection(FIRESTORE_STATE_COLLECTION)
      .doc(FIRESTORE_STATE_DOC)
      .onSnapshot((doc) => {
        if (!doc.exists) return;
        // Ignora alterações locais ainda não confirmadas
        if (doc.metadata && doc.metadata.hasPendingWrites) return;
        const data = doc.data() || {};
        const remoteSubjects = normalizeState(data.subjects || []);
        if (!remoteSubjects.length) return;
        // Evita re-render se não houve mudança relevante
        const current = JSON.stringify(state);
        const incoming = JSON.stringify(remoteSubjects);
        if (current === incoming) return;
        state = mergeRemoteWithLocalImages(remoteSubjects, state);
        localStorage.setItem(storageKey, JSON.stringify(state));
        render();
        setSyncStatus('Estado em tempo real atualizado', 'online');
      });
  } catch (err) {
    console.warn('Falha ao escutar estado do Firestore', err);
    setSyncStatus('Erro ao escutar estado', 'error');
  }
};

const deleteHistoryEntry = async (snapshotId) => {
  const index = history.findIndex((item) => item.id === snapshotId);
  if (index === -1) return;
  history.splice(index, 1);
  saveHistory();
  renderHistory();

  try {
    const db = await initFirestore();
    if (!db) return;
    await db.collection(FIRESTORE_COLLECTION).doc(snapshotId).delete();
    setSyncStatus('Histórico removido na nuvem', 'online');
  } catch (err) {
    console.warn('Falha ao remover do Firestore', err);
    setSyncStatus('Erro ao remover histórico', 'error');
  }
};

let state = normalizeState(load());
let history = loadHistory();
let activeTab = 'current';
isLoggedIn = localStorage.getItem(authKey) === '1';

const openImageModal = (src, alt) => {
  if (!$imageModal || !$imageModalImg) return;
  $imageModalImg.src = src;
  $imageModalImg.alt = alt || 'Imagem anexada';
  $imageModal.classList.add('active');
};

const closeImageModal = () => {
  if (!$imageModal || !$imageModalImg) return;
  $imageModal.classList.remove('active');
  $imageModalImg.src = '';
};

if ($imageModalClose) $imageModalClose.addEventListener('click', closeImageModal);
if ($imageModal) {
  $imageModal.addEventListener('click', (event) => {
    if (event.target === $imageModal) closeImageModal();
  });
}
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeImageModal();
});

const subscribeHistoryFromFirestore = async () => {
  try {
    const db = await initFirestore();
    if (!db) return;
    if (unsubscribeHistory) return;
    unsubscribeHistory = db
      .collection(FIRESTORE_COLLECTION)
      .orderBy('savedAt', 'desc')
      .limit(50)
      .onSnapshot((snap) => {
        const remoteHistory = snap.docs.map((doc) => {
          const data = doc.data() || {};
          return {
            id: doc.id,
            savedAt: data.savedAt || new Date().toISOString(),
            subjects: normalizeState(data.subjects),
            justification: data.justification || null,
            pending: Array.isArray(data.pending) ? data.pending : [],
          };
        });
        const merged = [...remoteHistory];
        history.forEach((item) => {
          if (!merged.find((r) => r.id === item.id)) merged.push(item);
        });
        history = merged.slice(0, 50);
        saveHistory();
        if (activeTab === 'history') renderHistory();
        setSyncStatus('Histórico em tempo real atualizado', 'online');
      });
  } catch (err) {
    console.warn('Falha ao escutar histórico do Firestore', err);
    setSyncStatus('Erro ao escutar histórico', 'error');
  }
};

const updateAuthUI = () => {
  const locked = !isLoggedIn;
  if ($loginStatus) $loginStatus.textContent = isLoggedIn ? 'Logado' : 'Deslogado';
  if ($loginBtn) $loginBtn.style.display = locked ? 'inline-flex' : 'none';
  if ($logoutBtn) $logoutBtn.style.display = locked ? 'none' : 'inline-flex';
  if ($loginPanel && isLoggedIn) $loginPanel.classList.remove('open');
  if ($createSection) $createSection.style.display = locked ? 'none' : 'block';
  if ($form) {
    const input = $form.querySelector('input[name="subject"]');
    const btn = $form.querySelector('button[type="submit"]');
    if (input) input.disabled = locked;
    if (btn) btn.disabled = locked;
  }
};

const setTab = (tab) => {
  activeTab = tab;
  if (tab === 'history') renderHistory();
  $tabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  $tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
};

$tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

if ($loginForm) {
  $loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const user = ($loginUser?.value || '').trim();
    const pass = ($loginPass?.value || '').trim();
    if (user === 'wellinton' && pass === 'wellinton7842') {
      isLoggedIn = true;
      saveAuth();
      updateAuthUI();
      render();
      alert('Login realizado com sucesso.');
      if ($loginPanel) $loginPanel.classList.remove('open');
    } else {
      alert('Credenciais inválidas.');
    }
  });
}

if ($loginBtn) {
  $loginBtn.addEventListener('click', () => {
    if (isLoggedIn) {
      alert('Você já está logado.');
      return;
    }
    if ($loginPanel) $loginPanel.classList.add('open');
    $loginUser?.focus();
  });
}

if ($logoutBtn) {
  $logoutBtn.addEventListener('click', () => {
    isLoggedIn = false;
    saveAuth();
    updateAuthUI();
    render();
    alert('Você saiu.');
  });
}

document.addEventListener('click', (event) => {
  if (!$loginPanel || !$loginPanel.classList.contains('open')) return;
  const clickedInside = $loginPanel.contains(event.target);
  const clickedButton = $loginBtn && $loginBtn.contains(event.target);
  if (!clickedInside && !clickedButton) {
    $loginPanel.classList.remove('open');
  }
});

const renderHistory = () => {
  if (!$historyList || !$historyEmpty) return;
  $historyList.innerHTML = '';

  if (!history.length) {
    $historyEmpty.style.display = 'block';
    return;
  }

  $historyEmpty.style.display = 'none';

  history.forEach((snapshot) => {
    const entry = document.createElement('article');
    entry.className = 'history-entry';

    const head = document.createElement('div');
    head.className = 'history-head';
    const title = document.createElement('h3');
    title.textContent = new Date(snapshot.savedAt || Date.now()).toLocaleString('pt-BR');
    const counts = document.createElement('span');
    counts.className = 'muted';
    const totalTopics = (snapshot.subjects || []).reduce((acc, s) => acc + ((s.topics || []).length), 0);
    const doneTopics = (snapshot.subjects || []).reduce((acc, s) => acc + (s.topics || []).filter((t) => t.done).length, 0);
    counts.textContent = `${doneTopics}/${totalTopics || 0} feitos`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'history-toggle';
    toggle.textContent = 'Ver detalhes';
    head.append(title, counts, toggle);

    if (isLoggedIn) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-secondary';
      deleteBtn.textContent = 'Excluir';
      deleteBtn.addEventListener('click', () => {
        const confirmDelete = window.confirm('Excluir este checklist salvo?');
        if (!confirmDelete) return;
        deleteHistoryEntry(snapshot.id);
      });
      head.appendChild(deleteBtn);
    }

    const subjectsWrap = document.createElement('div');
    subjectsWrap.className = 'history-subjects';

    (snapshot.subjects || []).forEach((sub) => {
      const section = document.createElement('section');
      section.className = 'history-subject';

      const subjectHead = document.createElement('div');
      subjectHead.className = 'history-subject-head';
      const h4 = document.createElement('h4');
      h4.textContent = sub.title || 'Assunto';
      const badge = document.createElement('span');
      badge.className = 'badge';
      const done = (sub.topics || []).filter((t) => t.done).length;
      const total = (sub.topics || []).length;
      badge.textContent = `${done}/${total || 0}`;
      subjectHead.append(h4, badge);

      const list = document.createElement('ul');
      list.className = 'history-topics';

      if (!(sub.topics || []).length) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'muted';
        emptyItem.textContent = 'Nenhum tópico';
        list.appendChild(emptyItem);
      } else {
        (sub.topics || []).forEach((t) => {
          const li = document.createElement('li');
          li.className = t.done ? 'done' : '';
          const hasImg = !!(t.imageUrl || t.image);
          const imageTag = hasImg ? ' (imagem)' : '';
          li.textContent = `${t.done ? '✓' : '•'} ${t.text}${imageTag}`;
          if (hasImg) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-ghost';
            btn.textContent = 'Ver imagem';
            btn.style.marginLeft = '8px';
            btn.addEventListener('click', () => openImageModal(t.imageUrl || t.image, t.text));
            li.appendChild(btn);
          }
          list.appendChild(li);
        });
      }

      section.append(subjectHead, list);
      subjectsWrap.appendChild(section);
    });

    const details = document.createElement('div');
    details.className = 'history-details';

    const hasMeta = (snapshot.pending && snapshot.pending.length) || snapshot.justification;
    if (hasMeta) {
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      if (snapshot.justification) {
        const p = document.createElement('p');
        p.textContent = `Justificativa: ${snapshot.justification}`;
        meta.appendChild(p);
      }
      if (snapshot.pending && snapshot.pending.length) {
        const ul = document.createElement('ul');
        ul.className = 'history-pending';
        snapshot.pending.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          ul.appendChild(li);
        });
        meta.appendChild(ul);
      }
      details.appendChild(meta);
    }
    details.appendChild(subjectsWrap);
    entry.append(head, details);

    const toggleDetails = () => {
      const isOpen = entry.classList.toggle('open');
      toggle.textContent = isOpen ? 'Fechar detalhes' : 'Ver detalhes';
    };

    toggle.addEventListener('click', toggleDetails);
    counts.addEventListener('click', toggleDetails);
    title.addEventListener('click', toggleDetails);

    $historyList.appendChild(entry);
  });
};

const render = () => {
  $subjects.innerHTML = '';
  if (!state.length) {
    $subjects.innerHTML = '<div class="empty">Nenhum assunto ainda. Crie o primeiro acima.</div>';
    return;
  }

  const createTopicElement = (topic, subjectTitle) => {
    const li = document.createElement('li');
    li.className = `topic ${topic.done ? 'done' : ''}`;
    li.dataset.topic = topic.id;

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!topic.done;
    const span = document.createElement('span');
    span.textContent = topic.text;
    label.append(checkbox, span);

    const actions = document.createElement('div');
    actions.className = 'topic-actions';
    const attachBtn = document.createElement('button');
    attachBtn.className = 'btn btn-secondary btn-ghost';
    attachBtn.type = 'button';
    attachBtn.dataset.attach = topic.id;
    attachBtn.textContent = 'Foto/Imagem';

    if (isLoggedIn) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-ghost';
      editBtn.type = 'button';
      editBtn.dataset.editTopic = topic.id;
      editBtn.textContent = 'Editar';
      actions.appendChild(editBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-secondary';
    removeBtn.type = 'button';
    removeBtn.dataset.remove = topic.id;
    removeBtn.textContent = 'Remover';
    actions.append(attachBtn, removeBtn);

    li.append(label, actions);

    if (topic.image || topic.imageUrl) {
      const imageWrap = document.createElement('div');
      imageWrap.className = 'topic-image';
      const img = document.createElement('img');
      img.src = topic.imageUrl || topic.image;
      img.alt = `Imagem de ${topic.text}`;
      const imageActions = document.createElement('div');
      imageActions.className = 'topic-image-actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-secondary btn-ghost';
      openBtn.type = 'button';
      openBtn.dataset.openImage = topic.id;
      openBtn.textContent = 'Abrir';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-secondary';
      clearBtn.type = 'button';
      clearBtn.dataset.clearImage = topic.id;
      clearBtn.textContent = 'Remover imagem';
      imageActions.append(openBtn, clearBtn);
      imageWrap.append(img, imageActions);
      li.appendChild(imageWrap);
    }

    return li;
  };

  state.forEach((subject) => {
    const doneCount = subject.topics.filter((t) => t.done).length;
    const total = subject.topics.length || 1;
    const percent = Math.round((doneCount / total) * 100);

    const wrapper = document.createElement('section');
    wrapper.className = 'subject';
    wrapper.dataset.id = subject.id;

    const header = document.createElement('div');
    header.className = 'subject-header';
    const h2 = document.createElement('h2');
    h2.textContent = `${subject.title} `;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${doneCount}/${subject.topics.length || 0}`;
    h2.appendChild(badge);
    const progress = document.createElement('div');
    progress.className = 'progress';
    progress.setAttribute('aria-label', `Progresso de ${subject.title}`);
    const progressSpan = document.createElement('span');
    progressSpan.style.width = `${percent}%`;
    progress.appendChild(progressSpan);
    if (isLoggedIn) {
      const actions = document.createElement('div');
      actions.className = 'subject-actions';

      const editSubjectBtn = document.createElement('button');
      editSubjectBtn.type = 'button';
      editSubjectBtn.className = 'btn btn-secondary btn-ghost';
      editSubjectBtn.dataset.editSubject = subject.id;
      editSubjectBtn.textContent = 'Editar assunto';

      const duplicateSubjectBtn = document.createElement('button');
      duplicateSubjectBtn.type = 'button';
      duplicateSubjectBtn.className = 'btn btn-secondary btn-ghost';
      duplicateSubjectBtn.dataset.cloneSubject = subject.id;
      duplicateSubjectBtn.textContent = 'Duplicar assunto';

      const deleteSubjectBtn = document.createElement('button');
      deleteSubjectBtn.type = 'button';
      deleteSubjectBtn.className = 'btn btn-secondary';
      deleteSubjectBtn.dataset.removeSubject = subject.id;
      deleteSubjectBtn.textContent = 'Excluir assunto';

      actions.append(editSubjectBtn, duplicateSubjectBtn, deleteSubjectBtn);
      header.append(h2, progress, actions);
    } else {
      header.append(h2, progress);
    }

    const list = document.createElement('ul');
    list.className = 'topics';
    subject.topics.forEach((topic) => list.appendChild(createTopicElement(topic, subject.title)));

    const addForm = document.createElement('form');
    addForm.className = 'add-topic';
    addForm.dataset.addTopic = '';
    const addInput = document.createElement('input');
    addInput.className = 'input';
    addInput.name = 'topic';
    addInput.placeholder = `Novo tópico em ${subject.title}`;
    addInput.required = true;
    const addButton = document.createElement('button');
    addButton.className = 'btn btn-primary';
    addButton.type = 'submit';
    addButton.textContent = 'Adicionar';
    addForm.append(addInput, addButton);

    if (isLoggedIn) {
      wrapper.append(header, list, addForm);
    } else {
      wrapper.append(header, list);
    }
    $subjects.appendChild(wrapper);
  });
};

$form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.target.subject;
  const title = (input.value || '').trim();
  if (!isLoggedIn) {
    alert('Faça login para criar um assunto.');
    return;
  }
  if (!title) return;
  state.push({ id: uid(), title, topics: [] });
  save();
  render();
  input.value = '';
  input.focus();
});

$subjects.addEventListener('mousemove', (event) => {
  const section = event.target.closest('.subject');
  if (!section) return;
  const rect = section.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  section.style.setProperty('--glow-x', `${x}%`);
  section.style.setProperty('--glow-y', `${y}%`);
});

$subjects.addEventListener('change', (event) => {
  if (event.target.type !== 'checkbox') return;
  const section = event.target.closest('.subject');
  const li = event.target.closest('.topic');
  if (!section || !li) return;
  const subjectId = section.dataset.id;
  const topicId = li.dataset.topic;
  const subject = state.find((s) => s.id === subjectId);
  if (!subject) return;
  const topic = subject.topics.find((t) => t.id === topicId);
  if (!topic) return;
  topic.done = event.target.checked;
  save();
  render();
});

const dataUrlToBlobUrl = (dataUrl) => {
  try {
    const [header, base64] = dataUrl.split(',');
    const mime = (header.match(/data:(.*?);base64/) || [])[1] || 'application/octet-stream';
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn('Falha ao converter imagem', err);
    return null;
  }
};

$subjects.addEventListener('click', (event) => {
  const section = event.target.closest('.subject');
  if (!section) return;
  const subject = state.find((s) => s.id === section.dataset.id);
  if (!subject) return;

  const editSubjectId = event.target.dataset.editSubject;
  if (editSubjectId) {
    if (!isLoggedIn) {
      alert('Faça login para editar um assunto.');
      return;
    }
    const nextTitle = window.prompt('Edite o assunto', subject.title || '');
    if (nextTitle === null) return;
    const trimmed = (nextTitle || '').trim();
    if (!trimmed) return;
    subject.title = trimmed;
    save();
    render();
    return;
  }

  const cloneSubjectId = event.target.dataset.cloneSubject;
  if (cloneSubjectId) {
    if (!isLoggedIn) {
      alert('Faça login para duplicar um assunto.');
      return;
    }
    const source = state.find((s) => s.id === cloneSubjectId);
    if (!source) return;
    const newSubjectId = uid();
    const copy = {
      id: newSubjectId,
      title: `${source.title} (cópia)`,
      topics: (source.topics || []).map((t) => ({
        ...t,
        id: uid(),
      })),
    };
    state.push(copy);
    save();
    render();
    return;
  }

  const removeSubjectId = event.target.dataset.removeSubject;
  if (removeSubjectId) {
    if (!isLoggedIn) {
      alert('Faça login para excluir um assunto.');
      return;
    }
    const confirmDelete = window.confirm('Excluir este assunto e todos os tópicos?');
    if (!confirmDelete) return;
    state = state.filter((s) => s.id !== removeSubjectId);
    save();
    render();
    return;
  }

  const editTopicId = event.target.dataset.editTopic;
  if (editTopicId) {
    if (!isLoggedIn) {
      alert('Faça login para editar um tópico.');
      return;
    }
    const topic = subject.topics.find((t) => t.id === editTopicId);
    if (!topic) return;
    const nextText = window.prompt('Edite o tópico', topic.text || '');
    if (nextText === null) return;
    const trimmed = (nextText || '').trim();
    if (!trimmed) return;
    topic.text = trimmed;
    save();
    render();
    return;
  }

  const attachId = event.target.dataset.attach;
  if (attachId) {
    $imageInput.dataset.subject = subject.id;
    $imageInput.dataset.topic = attachId;
    $imageInput.value = '';
    $imageInput.click();
    return;
  }

  const openImageId = event.target.dataset.openImage;
  if (openImageId) {
    const topic = subject.topics.find((t) => t.id === openImageId);
    if (!topic || (!topic.image && !topic.imageUrl)) return;
    const target = topic.imageUrl || topic.image;
    if (target.startsWith('data:')) {
      const blobUrl = dataUrlToBlobUrl(target);
      if (!blobUrl) return;
      const opened = window.open(blobUrl, '_blank');
      if (!opened) return;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } else {
      window.open(target, '_blank');
    }
    return;
  }

  const clearImageId = event.target.dataset.clearImage;
  if (clearImageId) {
    const topic = subject.topics.find((t) => t.id === clearImageId);
    if (!topic) return;
    delete topic.image;
    delete topic.imageUrl;
    save();
    render();
    return;
  }

  const removeId = event.target.dataset.remove;
  if (removeId) {
    subject.topics = subject.topics.filter((t) => t.id !== removeId);
    save();
    render();
    return;
  }
});

$imageInput.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  const subjectId = $imageInput.dataset.subject;
  const topicId = $imageInput.dataset.topic;
  if (!file || !subjectId || !topicId) {
    $imageInput.value = '';
    return;
  }
  (async () => {
    try {
      const url = await uploadImageToStorage(file, subjectId, topicId);
      const subject = state.find((s) => s.id === subjectId);
      if (!subject) return;
      const topic = subject.topics.find((t) => t.id === topicId);
      if (!topic) return;
      delete topic.image;
      topic.imageUrl = url;
      save();
      render();
    } catch (err) {
      console.warn('Falha ao enviar imagem', err);
      alert('Erro ao enviar imagem. Tente novamente.');
    } finally {
      $imageInput.value = '';
    }
  })();
});

$subjects.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-add-topic]');
  if (!form) return;
  if (!isLoggedIn) {
    alert('Faça login para adicionar tópicos.');
    return;
  }
  event.preventDefault();
  const section = event.target.closest('.subject');
  const subject = state.find((s) => s.id === section.dataset.id);
  if (!subject) return;
  const input = form.topic;
  const text = (input.value || '').trim();
  if (!text) return;
  subject.topics.push({ id: uid(), text, done: false });
  save();
  render();
  input.value = '';
  input.focus();
});

$saveDay.addEventListener('click', async () => {
  if (!state.length) {
    alert('Crie ao menos um assunto antes de salvar.');
    return;
  }

  const missingImages = [];
  state.forEach((subject) => {
    (subject.topics || []).forEach((topic) => {
      if (topic.done && !topic.image) missingImages.push(`${subject.title} - ${topic.text}`);
    });
  });
  if (missingImages.length) {
    const list = missingImages.slice(0, 5).map((item) => `- ${item}`).join('\n');
    const tail = missingImages.length > 5 ? '\n...' : '';
    alert(`Anexe uma imagem para cada tópico marcado antes de salvar.\nFaltando:\n${list}${tail}`);
    return;
  }

  const undoneTopics = [];
  state.forEach((subject) => {
    (subject.topics || []).forEach((topic) => {
      if (!topic.done) undoneTopics.push(`${subject.title} - ${topic.text}`);
    });
  });

  let justification = '';
  if (undoneTopics.length) {
    const list = undoneTopics.slice(0, 8).map((item) => `- ${item}`).join('\n');
    const tail = undoneTopics.length > 8 ? '\n...' : '';
    const promptMsg = `Existem tópicos não concluídos. Justifique o motivo:\n${list}${tail}`;
    const input = window.prompt(promptMsg, '');
    if (input === null) return;
    justification = (input || '').trim();
    if (!justification) {
      alert('A justificativa é obrigatória para salvar com tópicos pendentes.');
      return;
    }
  }

  const snapshot = {
    id: uid(),
    savedAt: new Date().toISOString(),
    subjects: JSON.parse(JSON.stringify(stripImages(state))),
    justification: justification || null,
    pending: undoneTopics,
  };
  history.unshift(snapshot);
  history = history.slice(0, 30);
  saveHistory();
  try {
    await persistSnapshotToFirestore(snapshot);
  } catch (err) {
    console.warn('Continuando com histórico local, mas o Firestore falhou', err);
    setSyncStatus('Erro ao salvar histórico', 'error');
  }
  state = state.map((subject) => ({
    ...subject,
    topics: Array.isArray(subject.topics)
      ? subject.topics.map((t) => {
        const { image, ...rest } = t;
        return { ...rest, done: false };
      })
      : [],
  }));
  save();
  render();
  setTab('history');
});

const startApp = async () => {
  render();
  renderHistory();
  setTab(activeTab);
  updateAuthUI();

  setSyncStatus('Conectando à nuvem...', 'syncing');
  const db = await initFirestore();
  if (!db) {
    setSyncStatus('Offline: Firestore indisponível', 'error');
    return;
  }

  setSyncStatus('Online - sincronizando', 'online');
  fetchStateFromFirestore();
  fetchHistoryFromFirestore();
  subscribeStateFromFirestore();
  subscribeHistoryFromFirestore();
};

startApp();
