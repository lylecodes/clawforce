# ClawPrint — Agent Team Benchmark Design

First standardized benchmark for AI agent TEAM performance. Tests coordination, not individual LLM ability.

## 8 Categories

1. **Goal Decomposition** — vague direction → concrete tasks
2. **Parallel Execution** — independent tasks, maximize throughput
3. **Dependency Chain** — respect task ordering (DAG)
4. **Failure Recovery** — injected failures, measure adaptation
5. **Budget Pressure** — limited resources, prioritization
6. **Quality Gate** — manager catches bad work via review
7. **Scaling** — same work, different team sizes
8. **Knowledge Sharing** — cross-agent learning

## 3 Scale Tiers

| Tier | Tasks | Agents | Budget | Time |
|------|-------|--------|--------|------|
| Small | 3-5 | 2-3 | $5 | 1hr |
| Medium | 10-15 | 4-6 | $20 | 2hr |
| Large | 30-40 | 8+ | $50 | 4hr |

## Scoring: ClawPrint Score (0-100)

| Dimension | Weight |
|-----------|--------|
| Completion | 25% |
| Quality | 20% |
| Efficiency | 20% |
| Coordination | 15% |
| Recovery | 10% |
| Budget | 10% |

## Two Modes

- **Simulated** — deterministic oracle, free, instant. For development and quick comparison.
- **Live** — real LLM calls via ClawForce dispatch. Costs money but produces publishable data.

## One Command

```bash
npx clawforce benchmark --scale medium --config my-team.yaml
npx clawforce benchmark --compare config-a.yaml config-b.yaml
npx clawforce benchmark --live --forge budget-pressure
```

## Integration

Built on ClawForce experiment framework. Each benchmark run IS an experiment — variant assignment, outcome recording, winner computation all reused.
