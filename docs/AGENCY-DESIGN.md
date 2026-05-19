# Agency Example — Design

O exemplo da agência substitui a pipeline linear
`ideia → texto → revisao → publicacao` por um mesh de uma agência de
desenvolvimento com várias equipes.

Estado: **implementado** — modelo de dados e roteamento definidos; os
`handoffs/` e `homes/` da agência estão no repositório.

## Equipes (v1)

Branding, Conteúdo, Jurídica. Desenvolvimento fica fora da v1.

## Modelo de dados — TRAVADO

Princípio: cada **entregável** aponta para uma FK só — o `briefing` que o
originou. O sujeito (cliente/brand) é alcançado por mais um hop, via o
briefing. Uma FK por entregável = exatamente o que a `fkInstruction` já
preenche, sem propagação de FK nova.

### Entidades base

| type       | FK obrigatória | FK opcional | papel              |
|------------|----------------|-------------|--------------------|
| `cliente`  | —              | —           | raiz               |
| `brand`    | `cliente`      | —           | 0..N por cliente   |
| `briefing` | `cliente`      | `brand`     | o pedido — hub     |

### Entregáveis (saída das equipes)

| type         | equipe    | FK         |
|--------------|-----------|------------|
| `identidade` | Branding  | `briefing` |
| `artigo`     | Conteúdo  | `briefing` |
| `politica`   | Jurídica  | `briefing` |
| `contrato`   | Jurídica  | `briefing` |

7 types no total.

### Relações reversas — inferidas de graça

`workspace.js` gera, sem ninguém escrever:

- `cliente.brands`, `cliente.briefings`
- `brand.briefings`
- `briefing.identidades`, `briefing.artigos`, `briefing.politicas`, `briefing.contratos`

### A complexidade "cliente sem brand"

Mora em `briefing.brand` ser opcional:

- briefing **sem** brand → trabalho client-level (ex: um contrato corporativo)
- briefing **com** brand → trabalho brand-scoped (ex: uma identidade)

A inferência detecta `brand` como nullable porque o campo só aparece em
alguns briefings — é o caso "site sem brand" generalizado.

### Exemplo de query

```graphql
query {
  clientes {
    nome
    brands { nome }
    briefings {
      titulo
      brand { nome }
      identidades { id }
      artigos { id }
      politicas { id }
      contratos { id }
    }
  }
}
```

## Intake — DECIDIDO

**briefing único + disparo manual.** Um só type `briefing`. O cliente (ou um
agent de atendimento) chama manualmente a mutation de cada equipe desejada.
Sem fan-out automático via watcher — três equipes não poderiam `trigger:` no
mesmo type `briefing` (o watcher faz 1 type → 1 handoff).

## Roteamento — DECIDIDO

1. **`cliente`, `brand` e `briefing` são seed manual.** Um humano escreve os
   `.md` no workspace — não há handoffs de criação. São as raízes do grafo;
   ninguém os produz a partir de outro artefato.
2. **Handoff multi-campo via caminho de arquivo.** Cada handoff de equipe
   recebe um `arg` do tipo `briefingPath` — o caminho do `.md` de briefing.
   O agent abre o arquivo e lê `cliente`/`brand`/`titulo` de lá. O handoff
   continua com um `arg` só; a `fkInstruction` casa `briefingPath` → o campo
   FK `briefing` do template automaticamente.
3. **Um handoff por entregável.** Branding 1 (`gerarIdentidade`), Conteúdo 1
   (`gerarArtigo`), Jurídica 2 (`gerarPolitica`, `gerarContrato`). 4 handoffs,
   todos manuais — nenhum tem `trigger:`.
4. **Sem home `atendimento`.** O cliente (ou um humano) chama as mutations
   direto; não há agent orquestrador na v1.

## Estrutura final

```
handoffs/                 homes/
  identidade.md             branding/.claude/agents/designer.md
  artigo.md                 conteudo/.claude/agents/redator.md
  politica.md               juridica/.claude/agents/advogado-politica.md
  contrato.md               juridica/.claude/agents/advogado-contrato.md
```

Os artefatos `cliente`/`brand`/`briefing` de exemplo vivem em `workspace/`
(não versionado). Para reproduzir: crie um `cliente`, um `brand` apontando
para ele, e um ou mais `briefing` — com `brand` (brand-scoped) ou sem
(client-level).
