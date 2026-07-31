import { describe, expect, it } from 'vitest';
import { primeiraFala } from './roteiro.js';

const ARQUIVO_REAL = `# INEMA Agentes HUB V — mulheres

## Versão 1 — Autonomia de verdade
### FALA (texto para o HeyGen — falar exatamente isto)
Autonomia de verdade com IA não é usar chatbot, é saber construir sistema.
Comece pela trilha de IA do seu perfil no inema.club.
### SOBREPOSIÇÕES DE TELA (fase do reel — NÃO falar)
- Headline gancho: "Autonomia de verdade com IA"

## Versão 2 — Nova oportunidade
### FALA (texto para o HeyGen — falar exatamente isto)
Construir sistemas de agentes de IA é uma das habilidades mais pedidas agora.

## ESTRUTURA
Fórmula: identificação → promessa → CTA.
`;

describe('primeiraFala', () => {
  it('extrai a fala e para no cabeçalho seguinte', () => {
    expect(primeiraFala(ARQUIVO_REAL)).toBe(
      'Autonomia de verdade com IA não é usar chatbot, é saber construir sistema.\n'
      + 'Comece pela trilha de IA do seu perfil no inema.club.',
    );
  });

  // O portão manda UM vídeo por público (`tituloEstudio` nomeia um só), então
  // ler a segunda versão de um arquivo antigo mandaria a pessoa gravar um texto
  // que não é o que o reel vai usar.
  it('ignora as versões seguintes dos arquivos antigos', () => {
    expect(primeiraFala(ARQUIVO_REAL)).not.toContain('habilidades mais pedidas');
  });

  it('lê o formato novo, de uma versão só', () => {
    const novo = '# assunto — jovens\n\n### FALA\nTem uma profissão nascendo agora.\n\n### SOBREPOSIÇÕES\n- x\n';
    expect(primeiraFala(novo)).toBe('Tem uma profissão nascendo agora.');
  });

  // Distinguir "não achei" de "achei vazio" é o que permite ao portão listar o
  // público como FALTA em vez de omiti-lo — lista curta passando por completa
  // é justamente o silêncio que o §8 proíbe.
  it('devolve null sem seção de fala', () => {
    expect(primeiraFala('# só isso\n\n## ESTRUTURA\nnada\n')).toBeNull();
  });

  it('devolve null com seção de fala vazia', () => {
    expect(primeiraFala('### FALA\n\n### SOBREPOSIÇÕES\n- x\n')).toBeNull();
  });

  it('devolve null em arquivo vazio', () => {
    expect(primeiraFala('')).toBeNull();
  });
});
