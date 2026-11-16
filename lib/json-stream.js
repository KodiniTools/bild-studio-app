// Kleiner JSON-Parser für sehr große Antworten: liest den Text stückweise und meldet
// Werte über Callbacks, statt alles in einen String bzw. ein Objekt zu laden.
// Nötig, weil Node Strings auf ca. 512 MB begrenzt und ein fertiger Batch-Auftrag mit
// vielen 4K-Bildern (base64 im JSON) größer wird.

// Gepufferte Strings (alles außer gestreamten) werden hier abgeschnitten
const MAX_BUFFERED_STRING = 1024 * 1024;
const STRING_END = /["\\]/g;
const LITERAL_END = /[\s,\]}]/g;
const ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * @param {object} handlers
 * @param {(path: (string|number)[], value: unknown) => void} [handlers.onValue]
 *   String (gepuffert), Zahl, true/false/null. `path` gilt nur während des Aufrufs.
 * @param {(path: (string|number)[]) => ({ write(text: string): void, end(): void }|null|undefined)} [handlers.openString]
 *   Liefert für einen String-Wert eine Senke, an die der Inhalt stückweise geht
 *   (dann kein onValue), oder nichts, wenn der String gepuffert werden soll.
 * @param {(path: (string|number)[]) => void} [handlers.onClose]
 *   Ende eines Objekts oder Arrays; `path` ist der Pfad des Objekts/Arrays selbst.
 */
export function createJsonStream(handlers = {}) {
  const stack = []; // { array: boolean, key: string|null, index: number, expectKey: boolean }
  let mode = 'structure'; // 'structure' | 'string' | 'literal'
  let isKey = false;
  let sink = null;
  let buffer = '';
  let escape = null; // null | '' (nach Backslash) | 'u…' (Unicode-Escape in Arbeit)
  let literal = '';

  const path = () => stack.map((f) => (f.array ? f.index : f.key));
  const top = () => stack[stack.length - 1];
  const beginValue = () => {
    const frame = top();
    if (frame?.array) frame.index += 1;
  };

  const emitText = (text) => {
    if (!text) return;
    if (sink) sink.write(text);
    else if (buffer.length < MAX_BUFFERED_STRING) {
      buffer += text.slice(0, MAX_BUFFERED_STRING - buffer.length);
    }
  };

  const endString = () => {
    mode = 'structure';
    if (isKey) {
      top().key = buffer;
      top().expectKey = false;
    } else if (sink) {
      sink.end();
    } else {
      handlers.onValue?.(path(), buffer);
    }
    sink = null;
    buffer = '';
  };

  const endLiteral = () => {
    mode = 'structure';
    let value;
    try {
      value = JSON.parse(literal);
    } catch {
      throw new Error(`Ungültiges JSON nahe „${literal.slice(0, 40)}“`);
    }
    literal = '';
    handlers.onValue?.(path(), value);
  };

  const write = (text) => {
    let pos = 0;
    const length = text.length;
    while (pos < length) {
      if (mode === 'string') {
        if (escape !== null) {
          // Escape-Sequenz, ggf. über Chunk-Grenzen hinweg
          const ch = text[pos];
          pos += 1;
          if (escape === '') {
            if (ch === 'u') escape = 'u';
            else {
              emitText(ESCAPES[ch] ?? ch);
              escape = null;
            }
          } else {
            escape += ch;
            if (escape.length === 5) {
              emitText(String.fromCharCode(parseInt(escape.slice(1), 16)));
              escape = null;
            }
          }
          continue;
        }
        STRING_END.lastIndex = pos;
        const match = STRING_END.exec(text);
        if (!match) {
          emitText(pos === 0 ? text : text.slice(pos));
          return;
        }
        emitText(text.slice(pos, match.index));
        pos = match.index + 1;
        if (match[0] === '"') endString();
        else escape = '';
        continue;
      }

      if (mode === 'literal') {
        LITERAL_END.lastIndex = pos;
        const match = LITERAL_END.exec(text);
        if (!match) {
          literal += text.slice(pos);
          return;
        }
        literal += text.slice(pos, match.index);
        pos = match.index; // Trennzeichen wird unten als Struktur verarbeitet
        endLiteral();
        continue;
      }

      const ch = text[pos];
      pos += 1;
      switch (ch) {
        case ' ':
        case '\n':
        case '\r':
        case '\t':
        case ':':
          break;
        case ',':
          if (top() && !top().array) top().expectKey = true;
          break;
        case '{':
          beginValue();
          stack.push({ array: false, key: null, index: -1, expectKey: true });
          break;
        case '[':
          beginValue();
          stack.push({ array: true, key: null, index: -1, expectKey: false });
          break;
        case '}':
        case ']':
          if (!stack.length) throw new Error('Ungültiges JSON: schließende Klammer ohne Anfang');
          handlers.onClose?.(path().slice(0, -1));
          stack.pop();
          break;
        case '"':
          mode = 'string';
          isKey = Boolean(top() && !top().array && top().expectKey);
          buffer = '';
          if (!isKey) {
            beginValue();
            sink = handlers.openString?.(path()) || null;
          }
          break;
        default:
          beginValue();
          mode = 'literal';
          literal = ch;
      }
    }
  };

  const end = () => {
    if (mode === 'literal') endLiteral();
    if (mode === 'string' || stack.length) throw new Error('JSON-Antwort endet unvollständig.');
  };

  return { write, end };
}

/**
 * Senke für base64-Text: dekodiert stückweise und gibt Bytes an `writeBytes` weiter.
 * `bytes` zählt die bisher geschriebenen Bytes.
 */
export function createBase64Sink(writeBytes, onEnd) {
  let carry = '';
  const state = {
    bytes: 0,
    write(text) {
      const all = carry + text;
      const usable = all.length - (all.length % 4);
      carry = all.slice(usable);
      if (usable) {
        const data = Buffer.from(all.slice(0, usable), 'base64');
        state.bytes += data.length;
        writeBytes(data);
      }
    },
    end() {
      if (carry) {
        const data = Buffer.from(carry, 'base64');
        state.bytes += data.length;
        if (data.length) writeBytes(data);
        carry = '';
      }
      onEnd?.(state.bytes);
    },
  };
  return state;
}
