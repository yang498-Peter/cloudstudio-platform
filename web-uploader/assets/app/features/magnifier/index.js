export function createMagnifierFeature({
  viewer,
  getRenderArea = () => document.getElementById('potree_render_area'),
  toast,
} = {}) {
  let controlsBound = false;
  let updateBound = false;

  const state = {
    active: false,
    pointerInside: false,
    clientX: 0,
    clientY: 0,
    lensSize: 184,
    sampleSize: 76,
    zoom: 2.4,
  };

  function getLens() {
    return document.getElementById('cursor-magnifier');
  }

  function getCanvas() {
    return document.getElementById('cursor-magnifier-canvas');
  }

  function getContext() {
    return getCanvas()?.getContext('2d') || null;
  }

  function getButtons() {
    return [
      document.getElementById('tb-magnifier'),
      document.getElementById('mi-t-magnifier'),
    ].filter(Boolean);
  }

  function syncButtons() {
    getButtons().forEach(button => button.classList.toggle('active', state.active));
  }

  function resizeLensCanvas() {
    const canvas = getCanvas();
    const ctx = getContext();
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const size = state.lensSize;
    const pixelSize = Math.round(size * dpr);
    if (canvas.width === pixelSize && canvas.height === pixelSize) return;
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  function hideLens() {
    const lens = getLens();
    if (lens) lens.classList.remove('show');
  }

  function positionLens() {
    const lens = getLens();
    const renderArea = getRenderArea?.();
    if (!lens || !renderArea) return;

    const rect = renderArea.getBoundingClientRect();
    const offset = 22;
    const margin = 10;
    let left = state.clientX + offset;
    let top = state.clientY + offset;

    if (left + state.lensSize + margin > rect.right) {
      left = state.clientX - state.lensSize - offset;
    }
    if (top + state.lensSize + margin > rect.bottom) {
      top = state.clientY - state.lensSize - offset;
    }

    left = Math.max(rect.left + margin, Math.min(left, rect.right - state.lensSize - margin));
    top = Math.max(rect.top + margin, Math.min(top, rect.bottom - state.lensSize - margin));

    lens.style.left = `${left}px`;
    lens.style.top = `${top}px`;
  }

  function drawCrosshair(ctx) {
    const size = state.lensSize;
    const center = size / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center, 12);
    ctx.lineTo(center, size - 12);
    ctx.moveTo(12, center);
    ctx.lineTo(size - 12, center);
    ctx.stroke();
    ctx.restore();
  }

  function drawLens() {
    const lens = getLens();
    const canvas = getCanvas();
    const ctx = getContext();
    const sourceCanvas = viewer?.renderer?.domElement;
    const renderArea = getRenderArea?.();
    if (!lens || !canvas || !ctx || !sourceCanvas || !renderArea) return;

    resizeLensCanvas();

    if (!state.active || !state.pointerInside) {
      lens.classList.remove('show');
      return;
    }

    const rect = renderArea.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      lens.classList.remove('show');
      return;
    }

    const px = state.clientX - rect.left;
    const py = state.clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) {
      lens.classList.remove('show');
      return;
    }

    const scaleX = sourceCanvas.width / rect.width;
    const scaleY = sourceCanvas.height / rect.height;
    const sampleWidth = state.sampleSize;
    const sampleHeight = state.sampleSize;
    const sourceSampleWidth = sampleWidth * scaleX;
    const sourceSampleHeight = sampleHeight * scaleY;
    const sourceX = (px * scaleX) - sourceSampleWidth / 2;
    const sourceY = (py * scaleY) - sourceSampleHeight / 2;

    ctx.clearRect(0, 0, state.lensSize, state.lensSize);
    ctx.fillStyle = '#061018';
    ctx.fillRect(0, 0, state.lensSize, state.lensSize);

    try {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        sourceSampleWidth,
        sourceSampleHeight,
        0,
        0,
        state.lensSize,
        state.lensSize
      );
    } catch (_error) {
      ctx.fillStyle = 'rgba(9, 19, 31, 0.94)';
      ctx.fillRect(0, 0, state.lensSize, state.lensSize);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, state.lensSize - 2, state.lensSize - 2);
    ctx.restore();

    drawCrosshair(ctx);
    positionLens();
    lens.classList.add('show');
  }

  function handlePointerMove(event) {
    if (!state.active) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    state.pointerInside = true;
    drawLens();
  }

  function handlePointerLeave() {
    state.pointerInside = false;
    hideLens();
  }

  function setActive(nextActive) {
    const next = Boolean(nextActive);
    if (state.active === next) return state.active;
    state.active = next;
    syncButtons();
    if (!next) {
      state.pointerInside = false;
      hideLens();
    } else {
      resizeLensCanvas();
      drawLens();
    }
    toast?.(next ? 'Magnifier enabled' : 'Magnifier disabled', 'info', 1800);
    return state.active;
  }

  function toggle() {
    return setActive(!state.active);
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    const renderArea = getRenderArea?.();
    resizeLensCanvas();

    document.getElementById('tb-magnifier')?.addEventListener('click', toggle);
    document.getElementById('mi-t-magnifier')?.addEventListener('click', toggle);

    renderArea?.addEventListener('mousemove', handlePointerMove);
    renderArea?.addEventListener('mouseenter', handlePointerMove);
    renderArea?.addEventListener('mouseleave', handlePointerLeave);
    window.addEventListener('blur', handlePointerLeave);
    window.addEventListener('resize', () => {
      resizeLensCanvas();
      if (state.active && state.pointerInside) drawLens();
    });

    if (!updateBound && viewer?.addEventListener) {
      updateBound = true;
      viewer.addEventListener('update', () => {
        if (state.active && state.pointerInside) drawLens();
      });
    }
  }

  return {
    bindControls,
    draw: drawLens,
    isActive: () => state.active,
    setActive,
    toggle,
  };
}
