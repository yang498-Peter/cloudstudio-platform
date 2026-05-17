function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createClipBoxFeature({
  getClipBoxState,
  getClipVolumes,
  getClipBoxDisplayName,
  setClipMode,
  startClipBoxSelection,
  confirmPendingClipBoxes,
  cancelCurrentClipBoxSelection,
  setClipBoxTranslationEnabled,
  setClipBoxRotationEnabled,
  activateClipTab,
  applyTranslations,
  toast,
} = {}) {
  let controlsBound = false;

  function t(key, fallback, vars = {}) {
    if (typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return fallback;
  }

  function getRoot() {
    return document.getElementById('clip-box-workspace');
  }

  function ensureWorkspaceShell() {
    const target = getRoot();
    if (!target || target.dataset.ready === '1') return target;
    target.dataset.ready = '1';
    target.innerHTML = `
      <div class="clip-delete-shell">
        <div class="clip-delete-head">
          <div>
            <div class="clip-delete-title" id="clip-box-title"></div>
            <div class="clip-delete-subtitle" id="clip-box-subtitle"></div>
          </div>
          <button class="btn pri clip-delete-start" id="btn-clipbox-start"></button>
        </div>
        <div class="clip-delete-meta-row">
          <div class="clip-delete-meta" id="clip-box-meta"></div>
          <div class="clip-delete-state" id="clip-box-state"></div>
        </div>
        <div class="clip-box-mode-grid">
          <button class="btn" id="btn-clip-mode-inside"></button>
          <button class="btn" id="btn-clip-mode-outside"></button>
        </div>
        <label class="clip-box-rotate-row">
          <input type="checkbox" id="chk-clipbox-translate">
          <span id="clip-box-translate-label"></span>
        </label>
        <label class="clip-box-rotate-row">
          <input type="checkbox" id="chk-clipbox-rotate">
          <span id="clip-box-rotate-label"></span>
        </label>
        <div class="clip-delete-note" id="clip-box-note"></div>
        <div class="clip-delete-actions">
          <button class="btn pri" id="btn-clipbox-confirm"></button>
          <button class="btn" id="btn-clipbox-cancel"></button>
        </div>
      </div>
    `;
    return target;
  }

  function updatePanel() {
    const root = ensureWorkspaceShell();
    if (!root) return;

    const title = document.getElementById('clip-box-title');
    const subtitle = document.getElementById('clip-box-subtitle');
    const meta = document.getElementById('clip-box-meta');
    const stateBadge = document.getElementById('clip-box-state');
    const note = document.getElementById('clip-box-note');
    const startButton = document.getElementById('btn-clipbox-start');
    const confirmButton = document.getElementById('btn-clipbox-confirm');
    const cancelButton = document.getElementById('btn-clipbox-cancel');
    const insideButton = document.getElementById('btn-clip-mode-inside');
    const outsideButton = document.getElementById('btn-clip-mode-outside');
    const translateCheckbox = document.getElementById('chk-clipbox-translate');
    const translateLabel = document.getElementById('clip-box-translate-label');
    const rotateCheckbox = document.getElementById('chk-clipbox-rotate');
    const rotateLabel = document.getElementById('clip-box-rotate-label');
    const state = getClipBoxState?.() || {};
    const volumes = getClipVolumes?.() || [];
    const staged = volumes.filter(volume => volume?.userData?.clipWorkflowState === 'staged');
    const confirmed = volumes.filter(volume => volume?.userData?.clipWorkflowState !== 'staged');
    const mode = state.mode || 'inside';

    if (!title || !subtitle || !meta || !stateBadge || !note || !startButton || !confirmButton || !cancelButton || !insideButton || !outsideButton || !translateCheckbox || !translateLabel || !rotateCheckbox || !rotateLabel) {
      return;
    }

    title.textContent = t('viewer.clipBox.workspaceTitle', 'Clip Box');
    subtitle.textContent = t(
      'viewer.clipBox.workspaceSubtitle',
      'Preview clip boxes first, then confirm them so clipping, export, and the object list stay in sync.'
    );
    startButton.textContent = state.active
      ? t('viewer.clipBox.selecting', 'Selecting...')
      : (staged.length || confirmed.length
        ? t('viewer.clipBox.addAnother', 'Add another clip box')
        : t('viewer.clipBox.start', 'Start clip box'));
    startButton.disabled = Boolean(state.active);

    confirmButton.textContent = t('viewer.clipBox.confirm', 'Confirm clip boxes');
    cancelButton.textContent = t('viewer.clipBox.cancel', 'Cancel current box');
    confirmButton.disabled = !staged.length;
    cancelButton.disabled = !state.active;

    insideButton.textContent = t('viewer.clipBox.modeInside', 'Clip Inside');
    outsideButton.textContent = t('viewer.clipBox.modeOutside', 'Clip Outside');
    insideButton.classList.toggle('active', mode === 'inside');
    outsideButton.classList.toggle('active', mode === 'outside');

    const editableSelected = Boolean(state.selectedVolume?.userData?.clipWorkflowState === 'staged');
    translateCheckbox.checked = Boolean(state.translationEnabled);
    translateCheckbox.disabled = !editableSelected;
    translateLabel.textContent = t('viewer.clipBox.translationToggle', 'Enable move handles for the selected clip box');
    rotateCheckbox.checked = Boolean(state.rotationEnabled);
    rotateCheckbox.disabled = !editableSelected;
    rotateLabel.textContent = t('viewer.clipBox.rotationToggle', 'Enable rotation handles for the selected clip box');

    meta.textContent = staged.length
      ? t('viewer.clipBox.metaPending', 'Pending {{pending}} | Saved {{saved}}', {
        pending: staged.length,
        saved: confirmed.length,
      })
      : (confirmed.length
        ? t('viewer.clipBox.metaSaved', 'Saved clip boxes {{count}}', { count: confirmed.length })
        : t('viewer.clipBox.metaIdle', 'No saved clip boxes'));

    stateBadge.textContent = state.active
      ? t('viewer.clipBox.stateSelecting', 'Drawing')
      : (staged.length
        ? t('viewer.clipBox.statePending', 'Previewing')
        : (confirmed.length ? t('viewer.clipBox.stateSaved', 'Saved') : t('viewer.clipBox.stateIdle', 'Idle')));
    stateBadge.className = `clip-delete-state ${state.active ? 'active' : (staged.length ? 'pending' : '')}`;

    const selectedName = typeof getClipBoxDisplayName === 'function' && state.selectedVolume
      ? getClipBoxDisplayName(state.selectedVolume)
      : '';
    note.textContent = state.active
      ? t('viewer.clipBox.noteActive', 'Place the clip box, adjust its size, then confirm it when the preview looks right.')
      : (staged.length
        ? t('viewer.clipBox.notePending', 'Pending clip boxes already affect the live preview. Confirm them to keep them for export and later editing.')
        : (confirmed.length
          ? t('viewer.clipBox.noteSaved', 'Saved clip boxes follow the current clip mode and are included in LAS export. Remove them individually or clear everything at the bottom.')
          : t('viewer.clipBox.noteIdle', 'Start a clip box to preview clipping. You can add several, then confirm them together.')));

    if (selectedName && !state.active) {
      note.textContent += ` ${t('viewer.clipBox.selectedHint', 'Selected')}: ${selectedName}`;
    }

    applyTranslations?.(root);
  }

  function bindControls() {
    ensureWorkspaceShell();
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('btn-clipbox-start')?.addEventListener('click', () => {
      activateClipTab?.();
      startClipBoxSelection?.();
    });
    document.getElementById('btn-clipbox-confirm')?.addEventListener('click', () => confirmPendingClipBoxes?.());
    document.getElementById('btn-clipbox-cancel')?.addEventListener('click', () => cancelCurrentClipBoxSelection?.({ notify: true }));
    document.getElementById('btn-clip-mode-inside')?.addEventListener('click', () => setClipMode?.('inside', { notify: true }));
    document.getElementById('btn-clip-mode-outside')?.addEventListener('click', () => setClipMode?.('outside', { notify: true }));
    document.getElementById('chk-clipbox-translate')?.addEventListener('change', event => {
      setClipBoxTranslationEnabled?.(event.target.checked, { notify: true });
    });
    document.getElementById('chk-clipbox-rotate')?.addEventListener('change', event => {
      setClipBoxRotationEnabled?.(event.target.checked, { notify: true });
    });
    document.getElementById('btn-add-clipbox')?.addEventListener('click', () => {
      activateClipTab?.();
      startClipBoxSelection?.();
    });
  }

  return {
    bindControls,
    updatePanel,
    refresh: updatePanel,
  };
}
