# Agency Example — Design

Doc de trabalho. O exemplo da agência substitui a pipeline linear
`ideia → texto → revisao → publicacao` por um mesh de uma agência de
desenvolvimento com várias equipes.

Estado: **modelo de dados travado**, roteamento em aberto.

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

## Roteamento — EM ABERTO

Questões a resolver antes de criar `handoffs/` e `homes/`:

1. **Como `cliente` e `brand` passam a existir?** Handoffs de criação
   (`criarCliente`, `criarBrand`) ou seed manual no workspace?
2. **Como o `briefing` é criado?** Tensão: um handoff tem **um arg só**, mas
   o briefing quer `cliente` (sempre) + `brand` (às vezes).
3. **Quantos handoffs por equipe?** Jurídica tem 2 entregáveis (politica,
   contrato); Branding e Conteúdo têm 1 cada — por enquanto.
4. **Precisa de um home `atendimento`** para orquestrar / criar briefings?
