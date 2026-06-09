export function createDisplaySettingsFeature({
  viewer,
  Potree,
  setProjectionMode,
  setEDLEnabledState,
  getDisplayQuickSync,
} = {}) {

  function bindRange(id, labelId, transform, apply) {
    const input = document.getElementById(id);
    const label = document.getElementById(labelId);
    if (!input) return;
    input.addEventListener('input', () => {
      const value = Number.parseFloat(input.value);
      const formatted = transform(value);
      if (label) label.textContent = formatted;
      apply(value);
    });
  }

  function bindControls() {
    bindRange('r-budget', 'l-budget', value => {
      const millions = value / 1e6;
      return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
    }, value => viewer.setPointBudget(value));
    bindRange('r-fov', 'l-fov', value => `${value}°`, value => viewer.setFOV(value));
    bindRange('r-edl-r', 'l-edl-r', value => value.toFixed(1), value => viewer.setEDLRadius(value));
    bindRange('r-edl-s', 'l-edl-s', value => value.toFixed(1), value => viewer.setEDLStrength(value));
    bindRange('r-edl-o', 'l-edl-o', value => value.toFixed(2), value => {
      try {
        viewer.setEDLOpacity(value);
      } catch (error) {
        console.warn('[display-settings] Failed to update EDL opacity', error);
      }
    });
    bindRange('r-xray-o', 'l-xray-o', value => value.toFixed(2), value => {
      viewer.scene.pointclouds.forEach(pointcloud => {
        pointcloud.material.opacity = value;
      });
    });
    bindRange('r-size', 'l-size', value => String(value), value => {
      viewer.scene.pointclouds.forEach(pointcloud => {
        pointcloud.material.size = value;
      });
    });

    const projection = document.getElementById('sel-projection');
    if (projection) {
      projection.addEventListener('change', event => setProjectionMode(event.target.value));
    }

    const shape = document.getElementById('sel-shape');
    if (shape) {
      shape.addEventListener('change', event => {
        const shapes = [Potree.PointShape.SQUARE, Potree.PointShape.CIRCLE];
        viewer.scene.pointclouds.forEach(pointcloud => {
          pointcloud.material.shape = shapes[Number(event.target.value)];
        });
      });
    }

    const sizeType = document.getElementById('sel-sizetype');
    if (sizeType) {
      sizeType.addEventListener('change', event => {
        const types = [Potree.PointSizeType.FIXED, Potree.PointSizeType.ADAPTIVE, Potree.PointSizeType.ATTENUATED];
        viewer.scene.pointclouds.forEach(pointcloud => {
          pointcloud.material.pointSizeType = types[Number(event.target.value)];
        });
      });
    }

    const edl = document.getElementById('chk-edl');
    if (edl) {
      edl.addEventListener('change', event => setEDLEnabledState(event.target.checked, { silent: true }));
    }

    document.querySelectorAll('[data-background]').forEach(button => {
      // Read backgrounds from data attributes so built-in and panoramic presets share one path.
      button.addEventListener('click', () => viewer.setBackground(button.dataset.background));
    });

    if (typeof getDisplayQuickSync === 'function') {
      getDisplayQuickSync()?.();
    }
  }

  return {
    bindControls,
  };
}
