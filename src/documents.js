// Validação de documentos (CPF e CNPJ), usada pelas notas de serviço e pelo
// módulo de pagamentos. Sem dependências, para não criar ciclo entre rotas.
//
// CNPJ e CPF. O CNPJ aceita o formato alfanumérico (letras nas 12 primeiras
// posições, a partir de julho de 2026): o dígito vale o código do caractere
// menos 48, então para CNPJs só com números a conta é a de sempre.

function onlyDocumentCharacters(value) {
  return String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function isValidCnpj(value) {
  const cnpj = onlyDocumentCharacters(value);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digit = (base) => {
    let weight = base.length - 7;
    let sum = 0;
    for (const character of base) {
      sum += (character.charCodeAt(0) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = digit(cnpj.slice(0, 12));
  const second = digit(cnpj.slice(0, 12) + first);
  return cnpj.endsWith(`${first}${second}`);
}

function isValidCpf(value) {
  const cpf = String(value ?? "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(cpf[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

module.exports = { onlyDocumentCharacters, isValidCnpj, isValidCpf };
