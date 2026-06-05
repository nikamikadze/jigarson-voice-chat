const BOUNDARY = /[.!?;:,\n]|[\u10a0-\u10ff]\s$/;

export function createChunker({ flushChars = 28, onChunk }) {
  let buffer = '';

  function emit(isFinal = false) {
    const chunk = buffer;
    buffer = '';
    onChunk(chunk, isFinal);
  }

  return {
    push(token) {
      buffer += token;
      if (buffer.length >= flushChars || BOUNDARY.test(buffer)) emit(false);
    },
    flush(isFinal = true) {
      if (buffer.trim()) emit(isFinal);
      else onChunk('', isFinal);
    }
  };
}
