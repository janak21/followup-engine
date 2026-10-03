// Pure, side-effect-free auto-layout for the journey builder canvas.
//
// Given the trigger's first step and the list of steps, this computes a
// top-down (vertical) layered layout: the trigger sits at the top and depth
// increases downward. Siblings spread horizontally. The result is a plain
// object of coordinates; it touches no React, DOM, or component state.
//
// Graph model (matches the canvas edge derivation in page.jsx):
//   - root node id "trigger"; edge trigger -> triggerNextStep when set
//   - for each step, edge step.index -> on_outcome[k].next_step for every
//     outcome whose next_step is numeric (terminal { exit } outcomes add none)
//
// This is a longest-path layered layout (depth = longest path from a root),
// which places a merge node (multiple parents) below all of its parents, and
// a barycenter ordering pass that sorts siblings by their parents' average x
// to reduce edge crossings. It is deterministic: same input -> same output.

// Spacing constants — exported so they can be tuned in one place.
export const Y_GAP = 220;   // vertical distance between consecutive depths
export const X_GAP = 345;   // horizontal distance between siblings at a depth
export const START_Y = 50;  // y of the trigger (depth 0)
export const CENTER_X = 250; // horizontal center the layout is balanced around

const TRIGGER_ID = "trigger";

/**
 * Compute a tidy top-down layout for the trigger + steps graph.
 *
 * @param {Object} args
 * @param {number|null} args.triggerNextStep - index of the step the trigger
 *   points at, or null if the trigger is not wired to a step yet.
 * @param {Array<{index:number, on_outcome?:Object}>} args.steps - journey steps.
 * @returns {{ trigger: {x:number,y:number}, steps: Object<string,{x:number,y:number}> }}
 *   `steps` is keyed by the step index (as an object key).
 */
export function computeLayout({ triggerNextStep, steps }) {
  const stepList = Array.isArray(steps) ? steps : [];

  // Node ids: the trigger plus every step index (as a string).
  const nodeIds = [TRIGGER_ID, ...stepList.map((s) => String(s.index))];

  // 1. Build adjacency + parent lists from the graph model above.
  const adj = {};
  const parents = {};
  nodeIds.forEach((id) => {
    adj[id] = [];
    parents[id] = [];
  });

  const addEdge = (from, to) => {
    // Guard against edges pointing at ids that do not exist (e.g. a next_step
    // referencing a deleted step). Only wire edges between known nodes.
    if (adj[from] && adj[to]) {
      adj[from].push(to);
      parents[to].push(from);
    }
  };

  if (triggerNextStep !== null && triggerNextStep !== undefined) {
    addEdge(TRIGGER_ID, String(triggerNextStep));
  }
  stepList.forEach((s) => {
    const outcomes = s.on_outcome || {};
    Object.keys(outcomes).forEach((key) => {
      const next = outcomes[key] && outcomes[key].next_step;
      if (typeof next === "number") {
        addEdge(String(s.index), String(next));
      }
    });
  });

  // 2. Longest-path layering. Roots (the trigger and any node with no parent)
  //    start at depth 0; every edge relaxes the target to at least parent+1.
  //    The relaxation is bounded by the node count so cycles / back-edges
  //    terminate instead of looping forever.
  const edges = [];
  nodeIds.forEach((u) => adj[u].forEach((v) => edges.push([u, v])));

  const layers = {};
  nodeIds.forEach((id) => {
    if (id === TRIGGER_ID || parents[id].length === 0) {
      layers[id] = 0;
    }
  });

  let changed = true;
  let iterations = 0;
  while (changed && iterations < nodeIds.length) {
    changed = false;
    edges.forEach(([u, v]) => {
      if (layers[u] !== undefined) {
        const nextLayer = layers[u] + 1;
        if (layers[v] === undefined || layers[v] < nextLayer) {
          layers[v] = nextLayer;
          changed = true;
        }
      }
    });
    iterations++;
  }

  // Any node not reached above (e.g. inside a disconnected cycle) lands at
  // depth 1 so it still gets a position.
  nodeIds.forEach((id) => {
    if (layers[id] === undefined) layers[id] = 1;
  });

  // 3. Group by depth, then order siblings by their parents' average x.
  const nodesByLayer = {};
  nodeIds.forEach((id) => {
    const l = layers[id];
    if (!nodesByLayer[l]) nodesByLayer[l] = [];
    nodesByLayer[l].push(id);
  });

  const positions = {};
  const sortedLayers = Object.keys(nodesByLayer)
    .map(Number)
    .sort((a, b) => a - b);

  sortedLayers.forEach((l) => {
    const layerNodes = nodesByLayer[l];

    if (l > 0) {
      const avgParentX = (id) => {
        const pList = parents[id] || [];
        if (pList.length === 0) return CENTER_X;
        const sum = pList.reduce(
          (acc, pId) => acc + (positions[pId] ? positions[pId].x : CENTER_X),
          0,
        );
        return sum / pList.length;
      };
      layerNodes.sort((a, b) => avgParentX(a) - avgParentX(b));
    }

    const count = layerNodes.length;
    layerNodes.forEach((id, index) => {
      positions[id] = {
        x: Math.round(CENTER_X + (index - (count - 1) / 2) * X_GAP),
        y: Math.round(START_Y + l * Y_GAP),
      };
    });
  });

  // 4. Split into the requested { trigger, steps } shape.
  const stepPositions = {};
  stepList.forEach((s) => {
    const pos = positions[String(s.index)];
    if (pos) stepPositions[s.index] = pos;
  });

  return {
    trigger: positions[TRIGGER_ID] || { x: CENTER_X, y: START_Y },
    steps: stepPositions,
  };
}
