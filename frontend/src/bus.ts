type Handler = (type: string, data: unknown) => void;

const handlers = new Set<Handler>();

/** In-page fan-out of live server events to whichever views are mounted. */
export const bus = {
  on(h: Handler): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  emit(type: string, data: unknown) {
    for (const h of [...handlers]) h(type, data);
  },
};
