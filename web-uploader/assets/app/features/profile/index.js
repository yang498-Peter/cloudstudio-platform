export function createProfileFeature({
  viewer,
  translateText = value => value,
  toast,
  setStatus,
  setToolMode,
  stopCapture,
  cancelActiveMeasurement,
  cancelClipBoxSelection,
  cancelVolumeSelection,
  cancelDeletePolygonSelection,
  hideAllVolumeRegionOverlays,
  activateClipTab,
  startClipBoxSelection,
  getProfileTool,
  getActiveProfile,
  setActiveProfile,
  ensureProfileInScene,
  syncProfileControllerProfile,
  showProfilePanel,
  setProfilePanelVisible,
  showProfileClipAction,
  hideProfileClipAction,
  getProfileWidth,
  setProfileWidthValue,
  formatLinearMeasurement,
  cycleProfileBackgroundMode,
  getProfileInfoEnabled,
  setProfileInfoEnabled,
  hideProfileSelectionProperties,
} = {}) {
  let controlsBound = false;
  let activeProfileInsertion = null;

  function startProfile() {
    if (!viewer.scene.pointclouds.length) {
      toast('Load a point cloud first', 'err');
      return null;
    }

    stopCapture();
    cancelActiveMeasurement?.({ notify: false });
    cancelClipBoxSelection?.({ notify: false });
    cancelVolumeSelection({ notify: false });
    cancelDeletePolygonSelection({ notify: false });
    hideAllVolumeRegionOverlays();
    hideProfileClipAction?.();
    setToolMode('profile');
    setStatus('Profile line - click the start point, then click the end point | ESC to cancel');
    activateClipTab?.();

    const width = getProfileWidth();
    cancelActiveProfile({ notify: false });
    const profile = getProfileTool?.()?.startInsertion?.({
      maxMarkers: 2,
      name: 'Profile',
    });
    setActiveProfile(profile);

    if (!profile) return null;
    activeProfileInsertion = profile;

    profile.setWidth(width);
    profile.addEventListener('finish', () => {
      if (activeProfileInsertion === profile) activeProfileInsertion = null;
      setToolMode(null);
      setStatus('Profile ready - review the section below or create a clip box');
      ensureProfileInScene(profile);
      syncProfileControllerProfile(profile);
      showProfilePanel();
      activateClipTab?.();
      showProfileClipAction?.(profile, () => startClipBoxSelection?.());
      toast('Profile line created', 'ok');
    });

    return profile;
  }

  function cancelActiveProfile({ notify = false } = {}) {
    const profile = activeProfileInsertion;
    activeProfileInsertion = null;
    if (!profile) return false;

    try {
      viewer.dispatchEvent?.({ type: 'cancel_insertions' });
    } catch (error) { }

    const pointCount = Array.isArray(profile.points) ? profile.points.length : 0;
    if (pointCount < 2) {
      try { viewer.scene.removeProfile(profile); } catch (error) { }
      if (getActiveProfile?.() === profile) setActiveProfile(null);
      setToolMode(null);
      setStatus('Ready');
      if (notify) toast(translateText('Cancel'), 'info');
      return true;
    }

    return false;
  }

  function openProfilePanel() {
    const profile = getActiveProfile();
    if (!profile) {
      toast('Draw a profile line first', 'err');
      return false;
    }
    syncProfileControllerProfile(profile);
    showProfilePanel();
    return true;
  }

  function closeProfilePanel() {
    setProfilePanelVisible(false);
  }

  function syncProfileWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width)) return;

    const profile = getActiveProfile();
    if (profile) {
      try {
        profile.setWidth(width);
      } catch (error) {
        profile.width = width;
      }
    }

    const label = formatLinearMeasurement(width, 'm', { digits: 1 });
    const widthLabel = document.getElementById('l-pw');
    const inlineLabel = document.getElementById('l-pw-inline');
    const widthSlider = document.getElementById('r-pw');
    const inlineSlider = document.getElementById('r-pw-inline');

    if (widthLabel) widthLabel.textContent = label;
    if (inlineLabel) inlineLabel.textContent = label;
    if (widthSlider) widthSlider.value = String(width);
    if (inlineSlider) inlineSlider.value = String(width);
    setProfileWidthValue(width);
  }

  function toggleProfileInfo() {
    const next = !getProfileInfoEnabled();
    setProfileInfoEnabled(next);
    document.getElementById('btn-profile-info-toggle')?.classList.toggle('active', next);
    if (!next) hideProfileSelectionProperties();
    toast(next ? 'Point info enabled' : 'Point info disabled', 'info', 1800);
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('btn-add-profile')?.addEventListener('click', startProfile);
    document.getElementById('btn-profile-view')?.addEventListener('click', openProfilePanel);
    document.getElementById('btn-close-profile')?.addEventListener('click', closeProfilePanel);
    document.getElementById('tb-profile')?.addEventListener('click', startProfile);
    document.getElementById('mi-t-profile')?.addEventListener('click', startProfile);
    document.getElementById('btn-profile-bg')?.addEventListener('click', cycleProfileBackgroundMode);
    document.getElementById('btn-profile-info-toggle')?.addEventListener('click', toggleProfileInfo);
    document.getElementById('r-pw')?.addEventListener('input', event => syncProfileWidth(parseFloat(event.target.value)));
    document.getElementById('r-pw-inline')?.addEventListener('input', event => syncProfileWidth(parseFloat(event.target.value)));
  }

  return {
    bindControls,
    cancelActiveProfile,
    closeProfilePanel,
    openProfilePanel,
    startProfile,
    syncProfileWidth,
  };
}
