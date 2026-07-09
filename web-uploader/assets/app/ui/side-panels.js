export function createSidePanelShell({
  document,
  window,
  isMobile,
  setLocalizedControlTitle,
  setRightPanelCollapsed,
} = {}) {
  let leftPanelCollapsed = false;

  const getById = (id) => document?.getElementById?.(id) || null;
  const mobile = () => !!isMobile?.();
  const dispatchResize = () => window?.dispatchEvent?.(new Event('resize'));

  function setLeftPanelCollapsed(collapsed) {
    leftPanelCollapsed = !!collapsed;
    getById('left-panel')?.classList.toggle('left-panel-collapsed', leftPanelCollapsed);
    setLocalizedControlTitle?.(
      getById('btn-mobile-left-open'),
      leftPanelCollapsed ? 'viewer.sceneTree.expandManager' : 'viewer.sceneTree.managerPanel',
      leftPanelCollapsed ? 'Expand Scene Manager' : 'Scene Manager',
    );
    dispatchResize();
  }

  function closeMobilePanels() {
    getById('left-panel')?.classList.remove('mobile-open');
    getById('right-panel')?.classList.remove('mobile-open');
    getById('mobile-backdrop')?.classList.remove('visible');
    dispatchResize();
  }

  function openMobilePanel(side) {
    closeMobilePanels();
    if (side === 'left') {
      getById('left-panel')?.classList.add('mobile-open');
    } else {
      getById('right-panel')?.classList.add('mobile-open');
    }
    getById('mobile-backdrop')?.classList.add('visible');
    dispatchResize();
  }

  function collapseLeftPanel() {
    if (mobile()) {
      closeMobilePanels();
      return;
    }
    setLeftPanelCollapsed(true);
  }

  function expandLeftPanel() {
    if (mobile()) {
      openMobilePanel('left');
      return;
    }
    setLeftPanelCollapsed(false);
  }

  function toggleLeftPanel() {
    if (mobile()) {
      openMobilePanel('left');
      return;
    }
    setLeftPanelCollapsed(!leftPanelCollapsed);
  }

  function setRightPanelCollapsedDom(collapsed) {
    const isCollapsed = !!collapsed;
    getById('layout')?.classList.toggle('right-panel-collapsed', isCollapsed);
    const reopenBtn = getById('btn-right-panel-reopen');
    if (reopenBtn && !mobile()) reopenBtn.style.display = isCollapsed ? 'inline-flex' : 'none';
    const collapseBtn = getById('btn-right-panel-toggle');
    setLocalizedControlTitle?.(
      collapseBtn,
      isCollapsed ? 'viewer.inspector.expandToolsPanel' : 'viewer.inspector.collapseToolsPanel',
      isCollapsed ? 'Expand tools panel' : 'Collapse tools panel',
    );
    setLocalizedControlTitle?.(reopenBtn, 'viewer.inspector.expandToolsPanel', 'Expand tools panel');
  }

  function bindLeftPanelControls() {
    getById('mobile-backdrop')?.addEventListener('click', closeMobilePanels);
    getById('btn-left-panel-collapse')?.addEventListener('click', collapseLeftPanel);
    getById('btn-mobile-left-open')?.addEventListener('click', expandLeftPanel);
  }

  function bindRightPanelControls() {
    getById('btn-right-panel-toggle')?.addEventListener('click', () => {
      setRightPanelCollapsed?.(true);
      if (mobile()) closeMobilePanels();
    });
    getById('btn-right-panel-reopen')?.addEventListener('click', () => {
      setRightPanelCollapsed?.(false);
      if (mobile()) openMobilePanel('right');
    });
  }

  function applyInitialMobileState() {
    if (mobile()) {
      getById('layout')?.classList.add('right-panel-collapsed');
    }
  }

  return {
    setLeftPanelCollapsed,
    collapseLeftPanel,
    expandLeftPanel,
    toggleLeftPanel,
    closeMobilePanels,
    openMobilePanel,
    setRightPanelCollapsedDom,
    bindLeftPanelControls,
    bindRightPanelControls,
    applyInitialMobileState,
    isLeftPanelCollapsed: () => leftPanelCollapsed,
  };
}
