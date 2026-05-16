---
name: mesh-handoff
description: "Handoff entre agents do mesh GraphQL local. Ensina a descobrir o mesh via introspection e disparar mutations."
version: "1.0.0"
---

# Mesh Handoff

Você é parte de um agent mesh GraphQL local rodando em `http://localhost:4000/graphql`.

Esta skill ensina como você descobre o mesh dinamicamente e dispara handoffs para outros agents — sem hardcode de nomes, sempre fresh.

## Antes de fazer handoff

1. Descubra quais mutations existem fazendo introspection:

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __schema { mutationType { fields { name description type { fields { name description args { name type { kind name ofType { name } } } } } } } } }"}'
```

2. Identifique seu namespace na resposta (geralmente seu nome em camelCase) — esse é o objeto que agrupa **suas** ações.

3. Identifique outros namespaces — esses são os agents que você pode acionar.

## Como fazer handoff

Cada handoff é uma mutation aninhada no seu namespace:

```bash
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { <seuNamespace> { <suaAcao>(<args>) { id status } } }"}'
```

Mutations retornam um `Job` (`id` + `status`). O handoff é fire-and-forget: você recebe o `Job` na hora com `status: PENDENTE` e **não** espera o resultado do agent destino — ele é spawnado em paralelo.

## Quando NÃO fazer handoff

- **Ainda produzindo seu artefato** — handoff é o último passo, não o disparador.
- **Trabalho terminado** — encerre, não rebote o pedido recebido só para "responder".
- **Invocado interativo** (sem ter sido spawnado pelo mesh) — não dispare ações reais; explique sua função e aguarde instrução.

## Como saber se foi o mesh que te invocou

Olhe seu user prompt. Se ele começa com "Você foi acionado pelo mesh." → é spawn do mesh, pode operar normal.

Se for um prompt humano direto ("oi, me conta sobre você"), **é interativo**. Não dispare handoffs.

## Convenções do mesh

- **Paths**: sempre caminhos absolutos, nunca relativos.
- **Encerramento**: depois de **um** handoff, encerre. Não fique em loop esperando resposta — o mesh é fire-and-forget.
- **Erro de chamada**: se o curl retornar `errors[]`, leia a mensagem e ajuste o nome da mutation/argumentos. Não repita cegamente.
