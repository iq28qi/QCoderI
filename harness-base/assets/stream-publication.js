// QCODERI_STREAM_PUBLICATION: bound expensive transcript publication by time,
// independently of display refresh rate. The assembler still accepts every
// delta; durable events and final settlement flush immediately without loss.
publish(publication) {
  if (publication === 'none') return;
  if (publication === 'animation-frame') {
    if (this.frameTimer !== undefined || this.frame !== undefined) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      const commit = () => { this.frame = undefined; this.flush(); };
      if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || !document.hidden)) this.frame = requestAnimationFrame(commit);
      else commit();
    }, typeof document !== 'undefined' && document.hidden ? 250 : 80);
    return;
  }
  this.cancelFrame();
  this.flush();
}
cancelFrame() {
  if (this.frameTimer !== undefined) clearTimeout(this.frameTimer);
  this.frameTimer = undefined;
  if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
  this.frame = undefined;
}
