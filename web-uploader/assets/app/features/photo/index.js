export function createPhotoFeature({
  viewer,
  THREE,
  getScannerState,
  getBasePath,
  buildCameraMarkers,
  getPhotoFrameAtIndex,
  getVisiblePhotoCameras,
  getFlyTrajectoryButtonLabel,
  formatTrajectoryFlySpeedLabel,
  translate,
  activateTrajectoryFlyNavigation,
  restoreTrajectoryFlyNavigation,
  toast,
} = {}) {
  let controlsBound = false;
  let raycastBound = false;
  let flyFrame = null;
  let flyTravelled = 0;
  let flyLastTime = 0;
  let navigationSnapshot = null;

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
    const basePath = getBasePath?.() || '';
    const cameraPath = String(frame.path || camera.path || '').replace(/\\/g, '/');
    const url = frame.url || (frame.panorama || camera.panorama
      ? `${basePath}/${cameraPath || frame.filename}`
      : `${basePath}/undistort/${frame.side}/${frame.filename}`);

    document.getElementById('photo-img').src = url;
    document.getElementById('photo-label').textContent = `${frame.index + 1} / ${frame.total}`;
    document.getElementById('photo-info').textContent = [
      translate('viewer.photo.info.position', { x: camera.x.toFixed(2), y: camera.y.toFixed(2), z: camera.z.toFixed(2) }, 'Position: ({{x}}, {{y}}, {{z}})'),
      translate('viewer.photo.info.orientation', { yaw: camera.yaw.toFixed(1), pitch: camera.pitch.toFixed(1) }, 'Orientation: Yaw {{yaw}}° Pitch {{pitch}}°'),
      translate('viewer.photo.info.camera', { side: frame.side.toUpperCase() }, 'Camera: {{side}}'),
      translate('viewer.photo.info.timestamp', { timestamp: camera.timestamp }, 'Timestamp: {{timestamp}}'),
    ].join(' | ');
    document.getElementById('modal-photo').classList.add('open');
  }

  function getTrajectoryFlySpeed() {
    const slider = document.getElementById('r-traj-fly-speed');
    const stateSpeed = Number(getState()?.trajectoryFlySettings?.speed);
    return Math.max(0.1, Number(slider?.value ?? stateSpeed) || 2);
  }

  function syncTrajectoryFlySpeedLabel(value = getTrajectoryFlySpeed()) {
    const label = document.getElementById('l-traj-fly-speed');
    if (label) label.textContent = formatTrajectoryFlySpeedLabel?.(value) || `${value.toFixed(1)} m/s`;
  }

  function getPointcloudWorldCenter(state) {
    const pointcloud = state?.pointcloud;
    const sourceBox = pointcloud?.boundingBox || pointcloud?.pcoGeometry?.tightBoundingBox || pointcloud?.pcoGeometry?.boundingBox;
    if (!pointcloud || !sourceBox?.getCenter) return null;
    try {
      pointcloud.updateMatrixWorld?.(true);
      const box = sourceBox.clone?.() || null;
      if (!box?.applyMatrix4) return null;
      box.applyMatrix4(pointcloud.matrixWorld);
      const center = box.getCenter(new THREE.Vector3());
      return Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z) ? center : null;
    } catch {
      return null;
    }
  }

  function chooseTrajectoryFlyPoints(state, localPoints, worldPoints) {
    if (!localPoints.length || localPoints.length !== worldPoints.length) return worldPoints;
    const cloudCenter = getPointcloudWorldCenter(state);
    if (!cloudCenter) return worldPoints;
    const localStartDistance = localPoints[0].distanceTo(cloudCenter);
    const worldStartDistance = worldPoints[0].distanceTo(cloudCenter);
    // Converted projected-coordinate projects can keep LAS/trajectory values in large real-world
    // coordinates while Potree renders the point cloud near a local scene origin. Drive the camera
    // in whichever coordinate space is closest to the rendered point cloud, not blindly in LAS space.
    return localStartDistance + 1e-6 < worldStartDistance ? localPoints : worldPoints;
  }

  function buildTrajectorySampler(state) {
    const odom = Array.isArray(state?.odomData) ? state.odomData : [];
    const origin = state?.trajectoryRenderOrigin || { x: 0, y: 0, z: 0 };
    const localPoints = odom
      .map(point => new THREE.Vector3(
        Number(point.x) - Number(origin.x || 0),
        Number(point.y) - Number(origin.y || 0),
        Number(point.z) - Number(origin.z || 0),
      ))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
    if (localPoints.length < 2) return null;

    const distances = [0];
    for (let index = 1; index < localPoints.length; index += 1) {
      distances[index] = distances[index - 1] + localPoints[index].distanceTo(localPoints[index - 1]);
    }

    const totalDistance = distances[distances.length - 1];
    if (!Number.isFinite(totalDistance) || totalDistance <= 0) return null;

    state.trajGroup?.updateMatrixWorld?.(true);
    const worldMatrix = state.trajGroup?.matrixWorld?.clone?.();
    const worldPoints = localPoints.map(point => (worldMatrix ? point.clone().applyMatrix4(worldMatrix) : point.clone()));
    const flyPoints = chooseTrajectoryFlyPoints(state, localPoints, worldPoints);

    function sample(distance) {
      const clamped = Math.max(0, Math.min(Number(distance) || 0, totalDistance));
      let low = 1;
      let high = distances.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (distances[mid] < clamped) low = mid + 1;
        else high = mid;
      }
      const index = low;
      const startDistance = distances[index - 1];
      const span = distances[index] - startDistance || 1;
      return flyPoints[index - 1].clone().lerp(flyPoints[index], (clamped - startDistance) / span);
    }

    return {
      totalDistance,
      sample,
    };
  }

  function setInitialTrajectoryView(sampler) {
    const start = sampler.sample(0);
    const ahead = sampler.sample(Math.min(sampler.totalDistance, 1));
    const horizontalDirection = ahead.clone().sub(start);
    horizontalDirection.z = 0;

    viewer.scene.view.position.copy(start);
    if (horizontalDirection.lengthSq() > 1e-8) {
      viewer.scene.view.direction = horizontalDirection.normalize();
    }
    viewer.scene.view.pitch = 0;
  }

  function stopFlyThrough({ silent = false } = {}) {
    if (flyFrame) {
      cancelAnimationFrame(flyFrame);
      flyFrame = null;
    }
    flyTravelled = 0;
    flyLastTime = 0;
    const state = getState();
    if (state) state.flyActive = false;
    restoreTrajectoryFlyNavigation?.(navigationSnapshot);
    navigationSnapshot = null;
    document.getElementById('btn-fly-traj')?.classList.remove('danger');
    const button = document.getElementById('btn-fly-traj');
    if (button) button.textContent = getFlyTrajectoryButtonLabel(false);
    closeModal();
    if (!silent) toast?.(translate?.('viewer.scanner.flyTrajectoryComplete', {}, 'Trajectory flythrough complete.') || 'Trajectory flythrough complete.', 'ok');
  }

  function startFlyThrough() {
    const state = getState();
    if (!state) return;
    if (flyFrame) {
      stopFlyThrough({ silent: true });
      return;
    }

    const sampler = buildTrajectorySampler(state);
    if (!sampler) {
      toast?.(translate?.('viewer.scanner.flyTrajectoryNoData', {}, 'Load a scanner trajectory before starting flythrough.') || 'Load a scanner trajectory before starting flythrough.', 'info', 3000);
      return;
    }

    const button = document.getElementById('btn-fly-traj');
    if (button) {
      button.textContent = getFlyTrajectoryButtonLabel(true);
      button.classList.add('danger');
    }
    state.flyActive = true;
    closeModal();
    navigationSnapshot = activateTrajectoryFlyNavigation?.() || null;
    setInitialTrajectoryView(sampler);
    syncTrajectoryFlySpeedLabel();
    toast?.(translate?.('viewer.scanner.flyTrajectoryRunning', {}, 'Flying through trajectory...') || 'Flying through trajectory...', 'info', 3000);

    // Integrate by trajectory arc length so the speed slider controls uniform path travel.
    const flyNext = timestamp => {
      if (!flyFrame) return;
      if (!flyLastTime) flyLastTime = timestamp;
      const deltaSeconds = Math.min(Math.max((timestamp - flyLastTime) / 1000, 0), 0.2);
      flyLastTime = timestamp;
      flyTravelled += getTrajectoryFlySpeed() * deltaSeconds;
      viewer.scene.view.position.copy(sampler.sample(flyTravelled));
      if (typeof viewer.setMoveSpeed === 'function') viewer.setMoveSpeed(getTrajectoryFlySpeed());
      if (typeof viewer.setRepRender === 'function') {
        viewer.setRepRender();
      }
      if (flyTravelled >= sampler.totalDistance) {
        stopFlyThrough({ silent: true });
        toast?.(translate?.('viewer.scanner.flyTrajectoryComplete', {}, 'Trajectory flythrough complete.') || 'Trajectory flythrough complete.', 'ok');
        return;
      }
      flyFrame = requestAnimationFrame(flyNext);
    };

    flyFrame = requestAnimationFrame(flyNext);
  }

  function bindCameraRaycast() {
    if (raycastBound) return;
    raycastBound = true;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const renderArea = document.getElementById('potree_render_area');
    if (!renderArea) return;

    renderArea.addEventListener('dblclick', event => {
      const state = getState();
      if (!state?.camGroup || !state.camGroup.visible) return;
      const rect = renderArea.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, viewer.scene.getActiveCamera());
      const intersects = raycaster.intersectObjects(state.camGroup.children, false);
      if (!intersects.length) return;
      const hit = intersects[0].object;
      if (hit.userData.type === 'camera') showPhoto(hit.userData.index, 'left');
    });
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
    document.getElementById('btn-fly-traj')?.addEventListener('click', startFlyThrough);
    bindCameraRaycast();
  }

  return {
    bindControls,
    closeModal,
    showPhoto,
    startFlyThrough,
    stopFlyThrough,
  };
}
