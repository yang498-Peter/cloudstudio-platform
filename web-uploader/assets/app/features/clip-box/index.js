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
  exportFilteredPointCloudAndOpen,
  applyTranslations,
  toast,
} = {}) {
  let controlsBound = false;
  let exportState = {
    busy: false,
    progress: 0,
    message: '',
  };

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
      <div class="clip-delete-shell clip-box-shell">
        <div class="clip-delete-head">
          <div class="clip-box-headline">
            <span class="clip-box-head-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="m12 4 7 4-7 4-7-4z"></path>
                <path d="M5 8v8l7 4 7-4V8"></path>
                <path d="M12 12v8"></path>
              </svg>
            </span>
            <div>
              <div class="clip-delete-title" id="clip-box-title"></div>
              <div class="clip-delete-subtitle" id="clip-box-subtitle"></div>
            </div>
          </div>
          <button class="btn pri clip-delete-start" id="btn-clipbox-start">
            <span class="clip-btn-glyph" aria-hidden="true">▷</span>
            <span id="clip-box-start-label"></span>
          </button>
        </div>
        <div class="clip-delete-meta-row">
          <div class="clip-delete-meta">
            <span class="clip-meta-icon" aria-hidden="true"></span>
            <span id="clip-box-meta"></span>
          </div>
          <div class="clip-delete-state" id="clip-box-state"></div>
        </div>
        <div class="clip-box-mode-grid">
          <button class="btn clip-mode-option" id="btn-clip-mode-inside">
            <span class="clip-mode-icon inside" aria-hidden="true"></span>
            <span class="clip-mode-label"></span>
          </button>
          <button class="btn clip-mode-option" id="btn-clip-mode-outside">
            <span class="clip-mode-icon outside" aria-hidden="true"></span>
            <span class="clip-mode-label"></span>
          </button>
        </div>
        <label class="clip-box-rotate-row">
          <span class="clip-toggle-icon move" aria-hidden="true"></span>
          <span class="clip-toggle-copy">
            <span id="clip-box-translate-label"></span>
            <small id="clip-box-translate-state"></small>
          </span>
          <input class="clip-box-switch" type="checkbox" id="chk-clipbox-translate">
        </label>
        <label class="clip-box-rotate-row">
          <span class="clip-toggle-icon rotate" aria-hidden="true"></span>
          <span class="clip-toggle-copy">
            <span id="clip-box-rotate-label"></span>
            <small id="clip-box-rotate-state"></small>
          </span>
          <input class="clip-box-switch" type="checkbox" id="chk-clipbox-rotate">
        </label>
        <div class="clip-delete-note"><span class="clip-note-icon" aria-hidden="true">i</span><span id="clip-box-note"></span></div>
        <div class="clip-delete-actions">
          <button class="btn pri" id="btn-clipbox-confirm"><span class="clip-btn-glyph" aria-hidden="true">○</span><span class="clip-action-label"></span></button>
          <button class="btn" id="btn-clipbox-cancel"><span class="clip-btn-glyph" aria-hidden="true">×</span><span class="clip-action-label"></span></button>
        </div>
        <div class="clip-export-block" id="clip-box-export-block">
          <button class="btn pri clip-export-open" id="btn-clipbox-export-open">
            <span class="clip-export-icon" aria-hidden="true"></span>
            <span class="clip-action-label"></span>
          </button>
          <div class="clip-export-progress" id="clip-box-export-progress" hidden>
            <div class="clip-export-progress-bar"><span></span></div>
            <div class="clip-export-progress-text"></div>
          </div>
          <div class="clip-export-hint" id="clip-box-export-hint"></div>
        </div>
      </div>
    `;
    return target;
  }

  function setButtonLabel(button, text) {
    const label = button?.querySelector('.clip-action-label, #clip-box-start-label');
    if (label) {
      label.textContent = text;
    } else if (button) {
      button.textContent = text;
    }
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
    const exportButton = document.getElementById('btn-clipbox-export-open');
    const exportProgress = document.getElementById('clip-box-export-progress');
    const exportProgressFill = exportProgress?.querySelector('.clip-export-progress-bar span');
    const exportProgressText = exportProgress?.querySelector('.clip-export-progress-text');
    const exportHint = document.getElementById('clip-box-export-hint');
    const insideButton = document.getElementById('btn-clip-mode-inside');
    const outsideButton = document.getElementById('btn-clip-mode-outside');
    const translateCheckbox = document.getElementById('chk-clipbox-translate');
    const translateLabel = document.getElementById('clip-box-translate-label');
    const translateState = document.getElementById('clip-box-translate-state');
    const rotateCheckbox = document.getElementById('chk-clipbox-rotate');
    const rotateLabel = document.getElementById('clip-box-rotate-label');
    const rotateState = document.getElementById('clip-box-rotate-state');
    const state = getClipBoxState?.() || {};
    const volumes = getClipVolumes?.() || [];
    const staged = volumes.filter(volume => volume?.userData?.clipWorkflowState === 'staged');
    const confirmed = volumes.filter(volume => volume?.userData?.clipWorkflowState !== 'staged');
    const mode = state.mode || 'inside';

    if (!title || !subtitle || !meta || !stateBadge || !note || !startButton || !confirmButton || !cancelButton || !exportButton || !insideButton || !outsideButton || !translateCheckbox || !translateLabel || !rotateCheckbox || !rotateLabel) {
      return;
    }

    title.textContent = t('viewer.clipBox.workspaceTitle', 'Clip Box');
    subtitle.textContent = t(
      'viewer.clipBox.workspaceSubtitle',
      'Preview clip boxes first, then confirm them so clipping, export, and the object list stay in sync.'
    );
    setButtonLabel(startButton, state.active
      ? t('viewer.clipBox.selecting', 'Selecting...')
      : (staged.length || confirmed.length
        ? t('viewer.clipBox.addAnother', 'Add another clip box')
        : t('viewer.clipBox.start', 'Start clip box')));
    startButton.disabled = Boolean(state.active || exportState.busy);

    setButtonLabel(confirmButton, t('viewer.clipBox.confirm', 'Confirm clip boxes'));
    setButtonLabel(cancelButton, t('viewer.clipBox.cancel', 'Cancel current box'));
    setButtonLabel(exportButton, t('viewer.clipBox.exportOpen', 'Export clipped LAS and open'));
    confirmButton.disabled = !staged.length || exportState.busy;
    cancelButton.disabled = !state.active || exportState.busy;
    exportButton.disabled = !confirmed.length || exportState.busy;

    const insideLabel = insideButton.querySelector('.clip-mode-label');
    const outsideLabel = outsideButton.querySelector('.clip-mode-label');
    if (insideLabel) insideLabel.textContent = t('viewer.clipBox.modeInside', 'Clip Inside');
    if (outsideLabel) outsideLabel.textContent = t('viewer.clipBox.modeOutside', 'Clip Outside');
    insideButton.classList.toggle('active', mode === 'inside');
    outsideButton.classList.toggle('active', mode === 'outside');
    insideButton.disabled = exportState.busy;
    outsideButton.disabled = exportState.busy;

    const editableSelected = Boolean(state.selectedVolume?.userData?.clipWorkflowState === 'staged');
    translateCheckbox.checked = Boolean(state.translationEnabled);
    translateCheckbox.disabled = !editableSelected || exportState.busy;
    translateLabel.textContent = t('viewer.clipBox.translationToggle', 'Enable move handles for the selected clip box');
    if (translateState) {
      translateState.textContent = editableSelected
        ? (state.translationEnabled ? t('viewer.common.on', 'On') : t('viewer.common.off', 'Off'))
        : '';
    }
    rotateCheckbox.checked = Boolean(state.rotationEnabled);
    rotateCheckbox.disabled = !editableSelected || exportState.busy;
    rotateLabel.textContent = t('viewer.clipBox.rotationToggle', 'Enable rotation handles for the selected clip box');
    if (rotateState) {
      rotateState.textContent = editableSelected
        ? (state.rotationEnabled ? t('viewer.common.on', 'On') : t('viewer.common.off', 'Off'))
        : '';
    }

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

    if (exportHint) {
      exportHint.textContent = confirmed.length
        ? t('viewer.clipBox.exportHintReady', 'Exports confirmed clip boxes to a new *_clip folder and opens the result as a new point cloud.')
        : t('viewer.clipBox.exportHintNeedSaved', 'Confirm at least one clip box before exporting the clipped result.');
    }
    if (exportProgress) {
      exportProgress.hidden = !exportState.busy;
    }
    if (exportProgressFill) {
      exportProgressFill.style.width = `${Math.max(0, Math.min(100, exportState.progress))}%`;
    }
    if (exportProgressText) {
      exportProgressText.textContent = exportState.message;
    }

    applyTranslations?.(root);
  }

  function setExportProgress(progress, message) {
    exportState = {
      busy: true,
      progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
      message: message || t('viewer.clipBox.exporting', 'Exporting clipped LAS for download...'),
    };
    updatePanel();
  }

  async function exportAndOpen() {
    if (exportState.busy) return;
    const confirmed = (getClipVolumes?.() || []).filter(volume => volume?.userData?.clipWorkflowState !== 'staged');
    if (!confirmed.length) {
      toast?.(t('viewer.clipBox.exportNeedSaved', 'Confirm at least one clip box before exporting.'), 'err');
      return;
    }
    if (typeof exportFilteredPointCloudAndOpen !== 'function') {
      toast?.(t('viewer.clipBox.exportUnavailable', 'Clip export is not available. Refresh the viewer and try again.'), 'err');
      return;
    }
    try {
      setExportProgress(8, t('viewer.clipBox.exporting', 'Exporting clipped LAS for download...'));
      await exportFilteredPointCloudAndOpen?.({
        reason: 'clip',
        onProgress: event => setExportProgress(event?.progress, event?.message),
      });
      setExportProgress(100, t('viewer.clipBox.exportComplete', 'Clipped LAS exported. Download started.'));
      toast?.(t('viewer.clipBox.exportComplete', 'Clipped LAS exported. Download started.'), 'ok', 4000);
    } catch (error) {
      toast?.(t('viewer.clipBox.exportFailed', 'Clip export failed: {{message}}', { message: error?.message || error }), 'err', 6000);
    } finally {
      exportState = { busy: false, progress: 0, message: '' };
      updatePanel();
    }
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
    document.getElementById('btn-clipbox-export-open')?.addEventListener('click', exportAndOpen);
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
