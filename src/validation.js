// Confere se o texto tem formato de UUID (evita erro do banco com ids malformados)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidUuid = (text) => typeof text === "string" && UUID_PATTERN.test(text);

module.exports = { isValidUuid };
