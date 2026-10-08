export function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (!node || node.localName !== tag) throw new Error(`Expected <${tag}> with id="${id}"`);
  return node as HTMLElementTagNameMap[K];
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  return context;
}
