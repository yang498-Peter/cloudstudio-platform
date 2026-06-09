export function createProfileFeature({
  viewer,
  translate,
  translateText,
  toast,
  setStatus,
  setToolMode,
  stopCapture,
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

  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    if (typeof window !== 'undefined' && typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  function startProfile() {
    if (!viewer.scene.pointclouds.length) {
      toast(t('viewer.profile.toast.needPointCloud', 'Load a point cloud first'), 'err');
      return null;
    }

    stopCapture();
    cancelVolumeSelection({ notify: false });
    cancelDeletePolygonSelection({ notify: false });
    hideAllVolumeRegionOverlays();
    hideProfileClipAction?.();
    setToolMode('profile');
    setStatus(t('viewer.profile.status.drawing', 'Profile line - click the start point, then click the end point | ESC to cancel'));
    activateClipTab?.();

    const width = getProfileWidth();
    const profile = getProfileTool?.()?.startInsertion?.({
      maxMarkers: 2,
      name: t('viewer.profile.name', 'Profile'),
    });
    setActiveProfile(profile);

    if (!profile) return null;

    profile.setWidth(width);
    profile.addEventListener('finish', () => {
      setToolMode(null);
      setStatus(t('viewer.profile.status.ready', 'Profile ready - review the section below or create a clip box'));
      ensureProfileInScene(profile);
      syncProfileControllerProfile(profile);
      showProfilePanel();
      activateClipTab?.();
      showProfileClipAction?.(profile, () => startClipBoxSelection?.());
      toast(t('viewer.profile.toast.created', 'Profile line created'), 'ok');
    });

    return profile;
  }

  function openProfilePanel() {
    const profile = getActiveProfile();
    if (!profile) {
      toast(t('viewer.profile.toast.drawFirst', 'Draw a profile line first'), 'err');
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
    toast(next ? t('viewer.profile.toast.pointInfoEnabled', 'Point info enabled') : t('viewer.profile.toast.pointInfoDisabled', 'Point info disabled'), 'info', 1800);
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
    closeProfilePanel,
    openProfilePanel,
    startProfile,
    syncProfileWidth,
  };
}
