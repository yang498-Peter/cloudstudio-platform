export function createPhotoFeature({
  getScannerState,
  getBasePath,
  getPhotoFrameAtIndex,
  translateText = text => text,
} = {}) {
  let controlsBound = false;

  function getState() {
    return getScannerState?.() || null;
  }

  function closeModal({ keepMini = false } = {}) {
    const modal = document.getElementById('modal-photo');
    if (!modal) return;
    if (keepMini) {
      modal.classList.remove('open');
      return;
    }
    modal.classList.remove('open', 'mini');
  }

  function showPhoto(index, side) {
    const state = getState();
    if (!state) return;
    const frame = getPhotoFrameAtIndex?.(index, side || 'left');
    if (!frame?.camera || !frame.filename) return;

    state.photoIndex = frame.index;
    state.photoSide = frame.side;

    const camera = frame.camera;
    const url = `${getBasePath?.()}/undistort/${frame.side}/${frame.filename}`;

    document.getElementById('photo-img').src = url;
    document.getElementById('photo-label').textContent = `${frame.index + 1} / ${frame.total}`;
    document.getElementById('photo-info').textContent =
      `${translateText('Position')}: (${camera.x.toFixed(2)}, ${camera.y.toFixed(2)}, ${camera.z.toFixed(2)}) | ` +
      `${translateText('Orientation')}: Yaw ${camera.yaw.toFixed(1)}° Pitch ${camera.pitch.toFixed(1)}° | ` +
      `${translateText('Camera')}: ${frame.side.toUpperCase()} | ${translateText('Timestamp')}: ${camera.timestamp}`;
    document.getElementById('modal-photo').classList.add('open');
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('photo-close')?.addEventListener('click', () => closeModal());
    document.getElementById('modal-photo')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) closeModal();
    });
    document.getElementById('photo-prev')?.addEventListener('click', () => {
      const state = getState();
      if (!state) return;
      showPhoto(state.photoIndex - 1, state.photoSide);
    });
    document.getElementById('photo-next')?.addEventListener('click', () => {
      const state = getState();
      if (!state) return;
      showPhoto(state.photoIndex + 1, state.photoSide);
    });
    document.getElementById('photo-toggle-lr')?.addEventListener('click', () => {
      const state = getState();
      if (!state) return;
      showPhoto(state.photoIndex, state.photoSide === 'left' ? 'right' : 'left');
    });
  }

  return {
    bindControls,
    closeModal,
    showPhoto,
  };
}
