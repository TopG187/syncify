/** Normalize layout to { edge, displayId }. */
function normalizeLayout(layout, fallbackDisplayId = null) {
  if (!layout) {
    return { edge: 'right', displayId: fallbackDisplayId };
  }
  if (typeof layout === 'string') {
    return { edge: layout, displayId: fallbackDisplayId };
  }
  return {
    edge: layout.edge || 'right',
    displayId: layout.displayId != null ? layout.displayId : fallbackDisplayId,
  };
}

function oppositeEdge(edge) {
  const map = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  return map[edge] || 'left';
}

module.exports = { normalizeLayout, oppositeEdge };
