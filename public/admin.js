'use strict';

(() => {
  const items = JSON.parse(document.getElementById('items-data').textContent);
  const form = document.getElementById('post-form');
  const f = form.elements;
  const details = document.getElementById('details');
  const msg = document.getElementById('form-msg');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const fetchBtn = document.getElementById('fetch-btn');
  const imgPreview = document.getElementById('img-preview');
  const composeTitle = document.getElementById('compose-title');

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
    return data;
  }

  function say(text, kind = 'ok') {
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.className = `notice ${kind}`;
  }

  function showImage() {
    imgPreview.hidden = !f.image.value;
    if (f.image.value) imgPreview.src = f.image.value;
  }

  function setCategory(id) {
    const radio = [...f.category].find((r) => r.value === id);
    if (radio) radio.checked = true;
  }

  async function preview() {
    if (!f.url.value) return f.url.reportValidity();
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching…';
    say('');
    try {
      const meta = await api('POST', '/api/preview', { url: f.url.value });
      f.url.value = meta.url;
      f.title.value = meta.title;
      f.description.value = meta.description;
      f.siteName.value = meta.siteName;
      f.image.value = meta.image;
      showImage();
      details.hidden = false;
      if (meta.duplicateOf) say('You already posted this link.', 'err');
      else if (meta.error) say(`Couldn't read the page (${meta.error}). Fill in the title yourself.`, 'err');
      (meta.title ? f.comment : f.title).focus();
    } catch (err) {
      say(err.message, 'err');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Fetch preview';
    }
  }

  function resetForm() {
    form.reset();
    f.id.value = '';
    details.hidden = true;
    imgPreview.hidden = true;
    composeTitle.textContent = 'Post a link';
    submitBtn.textContent = 'Publish';
    cancelBtn.hidden = true;
    f.url.readOnly = false;
    say('');
  }

  function startEdit(item) {
    f.id.value = item.id;
    f.url.value = item.url;
    f.url.readOnly = true;
    f.title.value = item.title;
    f.description.value = item.description || '';
    f.siteName.value = item.siteName || '';
    f.image.value = item.image || '';
    f.comment.value = item.comment || '';
    setCategory(item.category);
    showImage();
    details.hidden = false;
    composeTitle.textContent = 'Edit post';
    submitBtn.textContent = 'Save';
    cancelBtn.hidden = false;
    say('');
    document.getElementById('compose').scrollIntoView({ behavior: 'smooth' });
    f.comment.focus({ preventScroll: true });
  }

  fetchBtn.addEventListener('click', preview);
  f.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && details.hidden) { e.preventDefault(); preview(); }
  });
  f.image.addEventListener('change', showImage);
  cancelBtn.addEventListener('click', resetForm);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (details.hidden) return preview();
    const body = {
      url: f.url.value,
      title: f.title.value,
      description: f.description.value,
      siteName: f.siteName.value,
      image: f.image.value,
      comment: f.comment.value,
      category: f.category.value,
    };
    submitBtn.disabled = true;
    try {
      if (f.id.value) await api('PATCH', `/api/items/${encodeURIComponent(f.id.value)}`, body);
      else await api('POST', '/api/items', body);
      sessionStorage.setItem('flash', f.id.value ? 'Saved.' : 'Published.');
      location.href = '/admin';
    } catch (err) {
      say(err.message, 'err');
      submitBtn.disabled = false;
    }
  });

  document.querySelector('.admin-list').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const item = items.find((i) => i.id === li.dataset.id);
    if (e.target.matches('[data-edit]')) startEdit(item);
    if (e.target.matches('[data-delete]') && confirm(`Delete "${item.title}"?`)) {
      try {
        await api('DELETE', `/api/items/${encodeURIComponent(item.id)}`);
        li.remove();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  const bookmarklet = document.getElementById('bookmarklet');
  bookmarklet.href = `javascript:location.href=${JSON.stringify(`${location.origin}/admin?url=`)}+encodeURIComponent(location.href)`;
  bookmarklet.addEventListener('click', (e) => e.preventDefault());

  const flash = sessionStorage.getItem('flash');
  if (flash) {
    sessionStorage.removeItem('flash');
    say(flash);
  }

  // Arrived via the bookmarklet: fetch the preview straight away.
  if (f.url.value) preview();
})();
