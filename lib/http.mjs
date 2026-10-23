export async function readBody(req) {
  if (req.body != null) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > 8192) throw new Error('Requisição muito grande');
    return JSON.parse(text);
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new Error('Requisição muito grande');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
