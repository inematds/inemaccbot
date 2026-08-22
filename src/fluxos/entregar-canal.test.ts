import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entregarPacote, pacoteNoRecibo, resolverImports } from './entregar-canal.js';

function raiz(): string {
  return mkdtempSync(join(tmpdir(), 'canal-'));
}

/** Um pacote como o musicavideo monta: `<slug>/publicacao/` com tudo dentro. */
function pacote(base: string, slug = 'chuva-de-verao'): string {
  const p = join(base, slug, 'publicacao');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, `${slug}.mp4`), 'video');
  writeFileSync(join(p, 'capa-yt.jpg'), 'capa');
  writeFileSync(join(p, 'manifest.json'), '{"clips":[]}');
  return p;
}

describe('resolverImports', () => {
  it('resolve o canal pelo disco, e recusa token inválido', () => {
    const dir = raiz();
    mkdirSync(join(dir, 'yt-pub-lives10'), { recursive: true });
    expect(resolverImports('lives10', dir)).toBe(join(dir, 'yt-pub-lives10', 'imports'));
    expect(resolverImports('LIVES10', dir)).not.toBeNull();
    expect(resolverImports('lives99', dir)).toBeNull();
    expect(resolverImports('../etc', dir)).toBeNull();
  });
});

describe('pacoteNoRecibo', () => {
  it('lê o caminho da linha `publicacao:`', () => {
    const dir = raiz();
    const p = pacote(dir);
    const recibo = join(dir, 'recibo.txt');
    writeFileSync(recibo, `slug: chuva-de-verao\npublicacao: ${p}\n`);
    expect(pacoteNoRecibo(recibo)).toBe(p);
  });

  it('sem a linha, ou apontando para o que não existe, devolve null', () => {
    const dir = raiz();
    const semLinha = join(dir, 'a.txt');
    writeFileSync(semLinha, 'slug: x\ncapa: /tmp/capa.png\n');
    expect(pacoteNoRecibo(semLinha)).toBeNull();
    const sumiu = join(dir, 'b.txt');
    writeFileSync(sumiu, 'publicacao: /nao/existe/publicacao\n');
    expect(pacoteNoRecibo(sumiu)).toBeNull();
    expect(pacoteNoRecibo(join(dir, 'nao-existe.txt'))).toBeNull();
  });

  it('recusa caminho relativo — recibo é do domínio, não é comando', () => {
    const dir = raiz();
    const r = join(dir, 'c.txt');
    writeFileSync(r, 'publicacao: publicacao\n');
    expect(pacoteNoRecibo(r)).toBeNull();
  });
});

describe('entregarPacote', () => {
  it('vira um LOTE próprio em imports/<slug>, irmão de videos', () => {
    const dir = raiz();
    mkdirSync(join(dir, 'yt-pub-lives10', 'imports', 'videos'), { recursive: true });
    const ok = entregarPacote(pacote(dir), 'lives10', dir);
    expect(ok?.lote).toBe('chuva-de-verao');
    expect(ok?.destino).toBe(join(dir, 'yt-pub-lives10', 'imports', 'chuva-de-verao'));
    expect(readFileSync(join(ok!.destino, 'manifest.json'), 'utf8')).toContain('clips');
    expect(readFileSync(join(ok!.destino, 'capa-yt.jpg'), 'utf8')).toBe('capa');
    expect(readFileSync(join(ok!.destino, 'chuva-de-verao.mp4'), 'utf8')).toBe('video');
  });

  it('copia — o pacote continua na pasta do slug', () => {
    const dir = raiz();
    mkdirSync(join(dir, 'yt-pub-lives10'), { recursive: true });
    const p = pacote(dir);
    entregarPacote(p, 'lives10', dir);
    expect(readFileSync(join(p, 'manifest.json'), 'utf8')).toContain('clips');
  });

  it('reentrega substitui o lote e não deixa a pasta temporária', () => {
    const dir = raiz();
    mkdirSync(join(dir, 'yt-pub-lives10'), { recursive: true });
    const p = pacote(dir);
    const primeiro = entregarPacote(p, 'lives10', dir)!;
    writeFileSync(join(primeiro.destino, 'sobra.txt'), 'velho');
    const segundo = entregarPacote(p, 'lives10', dir)!;
    expect(() => readFileSync(join(segundo.destino, 'sobra.txt'), 'utf8')).toThrow();
    expect(() => readFileSync(join(dir, 'yt-pub-lives10', 'imports', '.chuva-de-verao.tmp'), 'utf8'))
      .toThrow();
  });

  it('canal inexistente devolve null — quem chama avisa e guarda o pacote', () => {
    const dir = raiz();
    expect(entregarPacote(pacote(dir), 'lives10', dir)).toBeNull();
  });
});
