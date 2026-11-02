# How a panel of models should deliberate

November 1, 2026, for The Council: a view where the user sends a thread and a message to a panel of models that deliberate. Sources: 35 papers read from their abstracts (arXiv, Semantic Scholar, OpenAlex, ACL Anthology), the README of Karpathy's `llm-council` and two of its followers on GitHub, and Perplexity's Model Council pages. Only abstracts were read, so numbers below are the papers' own headline figures; check the full text before quoting one in an ADR.

## Answer

The literature agrees on one shape, and it is the one Karpathy's `llm-council` (26k stars) and Perplexity's Model Council (February 2026) both ship:

1. **Blind first opinions.** Every panelist answers alone, in parallel, without seeing the others.
2. **Anonymous cross-review.** Each panelist reads the others' answers under neutral labels, in shuffled order, critiques them and ranks them. It may revise its own answer once.
3. **Chair synthesis.** One model writes the result: where the panel agrees, where it disagrees and why, what only one panelist saw, and a recommendation.

What the evidence adds to that shape:

- **One review round, not a long debate.** Most of debate's measured gain comes from voting over independent answers, not from the talking. More rounds before deciding lower accuracy, drift off the question, and flip right answers to wrong ones under peer pressure.
- **Different model families, but only strong ones.** Mixing providers is the single change that most reliably helps, and it also blocks runaway group bias. A weak model added for variety lowers the result.
- **Hide who said what from the models.** Models favor their own text and defer to named peers. Removing identity markers reduces both.
- **Keep the disagreement.** Debate pushes toward consensus, which suppresses exactly the variety a design call or a plan needs. The useful output for Sotto's kind of question is the disagreement, shown to the user, not averaged away.
- **It does not always beat one good model.** At equal cost, a single strong model with a good prompt, or the same model sampled several times and voted, often matches a debate. A council earns its cost on judgment calls with real uncertainty: plans, designs, reviews, risky decisions. Not lookups.

## The evidence, by design choice

### Is a council better than one model at all?

Mixed, and this is the part to be honest about in the product.

- Du et al. 2023, *Improving Factuality and Reasoning in Language Models through Multiagent Debate* ([2305.14325](https://arxiv.org/abs/2305.14325)): several instances propose, debate over rounds and converge; better maths, strategy and fewer hallucinations. The paper that started the field.
- Smit et al. 2023, *Should we be going MAD?* ([2311.17371](https://arxiv.org/abs/2311.17371)): debate does not reliably beat self-consistency or ensembling at the same cost. It is more sensitive to settings; tuning how readily agents agree helps most.
- Wang et al. 2024, *Rethinking the Bounds of LLM Reasoning* ([2402.18272](https://arxiv.org/abs/2402.18272)): one model with a strong prompt nearly matches the best discussion method. Discussion helps only when the prompt has no examples.
- Zhang et al. 2025, *Stop Overvaluing Multi-Agent Debate* ([2502.08788](https://arxiv.org/abs/2502.08788)): five debate methods, nine benchmarks; debate often loses to chain-of-thought and self-consistency while spending more. Model heterogeneity is the one change that consistently helps.
- Choi et al. 2025, *Debate or Vote* ([2508.17536](https://arxiv.org/abs/2508.17536)): majority voting alone accounts for most of debate's gain. They prove plain debate is a martingale: it does not raise expected correctness on its own. Debate helps only when updates are nudged toward correction.
- Motger et al. 2026, survey of 141 debate studies ([2607.26212](https://arxiv.org/abs/2607.26212)): the field settled on fully connected panels, verbatim exchange and a final vote by convention, not by comparison.

### Blind first round

- Choi et al. 2025 and Zhu et al. 2026, *Demystifying Multi-Agent Debate* ([ACL Findings](https://doi.org/10.18653/v1/2026.findings-acl.1694)): the gain depends on a right answer being somewhere in the starting pool, and independent, diverse first answers raise that chance.
- Kaesberg et al. 2025, *All-Agents Drafting* in *Voting or Consensus?* ([2502.19130](https://arxiv.org/abs/2502.19130)): having every agent draft independently before discussion improved results by up to 3.3%.
- Schoenegger et al. 2024, *Wisdom of the silicon crowd* ([2402.19379](https://arxiv.org/abs/2402.19379)): twelve models' independent forecasts, simply averaged, matched a crowd of 925 human forecasters.

### Anonymity and order

- Choi et al. 2026, *When Identity Skews Debate* ([ACL 2026](https://doi.org/10.18653/v1/2026.acl-long.650)): agents either copy a peer or cling to their own answer depending on whose it is. Stripping identity markers, so an agent cannot tell its answer from a peer's, reduces both. Proposes a measure, the Identity Bias Coefficient.
- Panickssery et al. 2024, *LLM Evaluators Recognize and Favor Their Own Generations* ([2404.13076](https://arxiv.org/abs/2404.13076)): models can recognize their own text, and the better they recognize it the more they favor it. A label alone does not fully hide authorship; style gives it away.
- Wang et al. 2023, *Large Language Models are not Fair Evaluators* ([2305.17926](https://arxiv.org/abs/2305.17926)): swapping the order of two answers can flip a judge's verdict. Shuffle, or judge both orders.
- Zheng et al. 2023, *Judging LLM-as-a-judge* ([2306.05685](https://arxiv.org/abs/2306.05685)): judges show position, length and self-preference bias.

### Who sits on the panel

- Chen et al. 2023, *ReConcile* ([2309.13007](https://arxiv.org/abs/2309.13007)): a round table of different models with confidence-weighted voting beat single- and multi-agent baselines by up to 11.4%; diversity from different models was critical.
- Verga et al. 2024, *Replacing Judges with Juries* ([2404.18796](https://arxiv.org/abs/2404.18796)): a panel of smaller models from different families judged better than one large model, with less bias, at a seventh of the cost.
- Okawa 2026, *Emergence of Biased Consensus* ([2608.02827](https://arxiv.org/abs/2608.02827)): above a conformity threshold a panel locks into a shared bias; heterogeneous agents smooth that transition away.
- Wu et al. 2025, *Can LLM Agents Really Debate?* ([2511.07784](https://arxiv.org/abs/2511.07784)): each agent's own reasoning strength and the group's diversity decide the outcome. Speaking order and showing confidence matter little.
- Against: Li et al. 2025, *Rethinking Mixture-of-Agents* ([2502.00674](https://arxiv.org/abs/2502.00674)): aggregating several samples of the single best model beat mixing different models (6.6% on AlpacaEval 2.0), because mixing lowers average quality. The paper names narrower cases where mixing helps; not read here.
- Ali 2026, *Quantifying Diversity of Thought* ([2607.17384](https://arxiv.org/abs/2607.17384)): an ensemble's lift is predicted by how differently two models are wrong, given their accuracy gap. Two strong models that fail on different questions gain most.

So: three to five strong models from different providers, no filler. The same model run several times is a reasonable fallback when only one strong provider is connected.

### How big, how many rounds

- Kaesberg et al. 2025 ([2502.19130](https://arxiv.org/abs/2502.19130)): more agents helped; more discussion rounds before the vote hurt.
- Chen et al. 2024, *Are More LLM Calls All You Need?* ([2403.02419](https://arxiv.org/abs/2403.02419)): accuracy can rise then fall with more calls, because extra calls help easy questions and hurt hard ones.
- Li et al. 2024, *More Agents Is All You Need* ([2402.05120](https://arxiv.org/abs/2402.05120)): sampling and voting scales with the number of agents, more so on harder tasks.
- Zhao et al. 2024, *Language Model Council* ([2406.08598](https://arxiv.org/abs/2406.08598)): a council of 20 models ranking each other agreed with people better than any single judge. Using every model is costly, and the paper studies what each extra judge is worth.
- Li et al. 2024, *Sparse Communication Topology* ([2406.11776](https://arxiv.org/abs/2406.11776)): agents need not all read each other; sparser panels did as well for less.

### What goes wrong in longer debate

- Wynn et al. 2025, *Talk Isn't Always Cheap* ([2509.05396](https://arxiv.org/abs/2509.05396)): accuracy can fall over rounds even when strong models outnumber weak ones; models move from right to wrong to agree.
- Hao et al. 2026, *Not All Flips Are Conformity* ([2606.00820](https://arxiv.org/abs/2606.00820)): 37% of agents change answer with no peer input at all, so not every change is persuasion. Exchanging full reasoning gave no extra voting gain over self-reflection and used 57% more tokens.
- Becker et al. 2026, *Stay Focused: Problem Drift* ([EACL Findings](https://doi.org/10.18653/v1/2026.findings-eacl.268)): debates drift off the question, most on open-ended generative tasks (76 to 89% of them), from lack of progress and weak feedback.
- Nguyen et al. 2026, *Does Debate Suppress Diversity?* ([EMNLP 2026](https://doi.org/10.18653/2026.emnlp-main.2298)): debate's pull toward agreement removes the variety creative and ideation work needs. Holding each agent to a distinct lens, and showing it the most different peers, kept it.
- Kasprova et al. 2026, *Too Polite to Disagree* ([SIGDIAL 2026](https://doi.org/10.18653/v1/2026.sigdial-1.56)): telling agents which peers tend to agree too easily cut error cascades and added 10.5 points.
- Liang et al. 2023, *Encouraging Divergent Thinking* ([2305.19118](https://arxiv.org/abs/2305.19118)): a single model reflecting on itself gets stuck; a debate with a judge helps, but a judge from one family is not fair to agents from others.

### Deciding

- Kaesberg et al. 2025 ([2502.19130](https://arxiv.org/abs/2502.19130)): voting is better for reasoning questions (+13.2%), consensus for knowledge questions (+2.8%).
- Chen et al. 2023, *Universal Self-Consistency* ([2311.17311](https://arxiv.org/abs/2311.17311)): for free-form answers that cannot be counted, a model picks the most consistent candidate. This is what a chair does.
- Jiang et al. 2023, *LLM-Blender* ([2306.02561](https://arxiv.org/abs/2306.02561)) and Wang et al. 2024, *Mixture-of-Agents* ([2406.04692](https://arxiv.org/abs/2406.04692)): rank the candidates pairwise, then fuse the best into one answer; layered aggregation of many models' answers.
- Cui et al. 2026, *Free-MAD* ([ACL Findings](https://doi.org/10.18653/v1/2026.findings-acl.1600)): drop the need for consensus and score the whole exchange, so an agent that was right first and then gave in still counts.
- Stan et al. 2026, *Bayesian Dialectical Argumentation for multi-LLM councils* ([2610.02005](https://arxiv.org/abs/2610.02005)): a council's stated confidence measures decisiveness, not correctness. Reading who proposed, challenged and conceded what gives calibrated confidence and discounts an unreliable member.
- Fan et al. 2026, *iMAD* ([AAAI 2026](https://doi.org/10.1609/aaai.v40i35.40181)): call the panel only when one model's answer shows hesitation; always debating wastes tokens and can overturn right answers.
- de Quijano 2026, *Quorum* ([Zenodo, not peer-reviewed](https://doi.org/10.5281/zenodo.21962849)): three models from different labs answer in isolation, critique claim by claim under blind labels, revise, and a non-debating arbiter gives a verdict with dissent preserved. It claims no better answers, only that the transcript of disagreement is the product. The closest published match to Sotto's case, but self-published.

## What ships today

- **Karpathy, `llm-council`** ([GitHub](https://github.com/karpathy/llm-council), November 2025): the three stages above, through OpenRouter. Stage 1 answers in tabs, stage 2 anonymized ranking by every model, stage 3 a chairman model writes the final answer. A weekend project, unsupported.
- **Perplexity, Model Council** ([launch](https://www.perplexity.ai/hub/blog/introducing-model-council), February 5, 2026; [in Computer](https://www.perplexity.ai/hub/blog/model-council-comes-to-computer), July 28, 2026): three frontier models answer at once; a synthesizer shows agreement, disagreement and unique points. Capped per month.
- **Claude Code skills** (`aiwithremy/claude-skills-llm-council`, 2.9k stars): five advisors, each told to think from a different angle, peer review, a chairman's verdict that names agreements and clashes. Its README says it suits judgment calls and not lookups or writing tasks.
- **`usetig/sage`**: a second model reviews a coding agent's plans and replies before code is written, moving toward a council.

## What this means for Sotto

**Panelists are threads, not API calls.** Each panelist can be an ordinary Sotto thread on its provider (Claude Code, Codex, Grok Build, Muse, Devin, OpenCode, Cursor, DeepSeek Harness), which keeps the README's promise that threads go to the agent's own provider and adds no host. Karpathy's route, OpenRouter for every panelist, would spend the cleanup key on something new; the README says that key is only for cleanup and Owl's transcription, so that route is an ADR and a README change first. Threads also give what no API council has: each panelist can read the project itself, so its opinion rests on the code, not only on the pasted thread.

**Delegation is the machinery.** ADR-0081 already starts linked threads, holds them to a permission ceiling, stops them with their parent and reports outcomes. A council is a fan-out of delegations with Sotto, not a model, carrying text between stages. Panelists should start read-only: they advise, they do not edit. Delegation is an Owl feature (ADR-0072), so a Council built on it stays on Owl until delegation goes to stable, whatever the Council's own entry says.

**Anonymity holds even though the user sees names.** Main carries each stage's answers to the next under labels it shuffles per reader, with model and provider names removed. The user sees who said what; the panelists do not. Style can still give a model's own text away (Panickssery 2024), so the chair should ideally not sit on the panel.

**The output is the disagreement.** For Sotto's questions (a plan, a design, a review, which approach), the chair's synthesis should lead with the recommendation, then the points of agreement, then each disagreement with each side's best case and who held it, then what only one panelist noticed. Votes and rankings are shown, not hidden in a blended answer.

**Defaults the evidence supports:** three panelists from three providers; one blind round, one anonymous review round with one optional revision, then the chair; no further rounds unless the user asks. The user picks the panel and the chair, and can open, stop or answer any panelist's thread.

**Cost.** Each panelist is a full thread, so one council turn costs roughly panel size times two turns, plus the chair. With context of a long thread forwarded to each, that is the dominant cost. Sending the whole transcript keeps fidelity; sending a condensed brief saves tokens but lets the condenser shape what the panel sees. That trade is open.

## Not checked

- Full texts: only abstracts were read.
- X and practitioner reports were not searched.
- No paper measured councils on coding plans or design reviews specifically; the evidence is from reasoning, knowledge, judging, forecasting and creative benchmarks. Applying it to Sotto's questions is inference.

## Decided

Drake, November 1, 2026: The Council is an Owl feature, and its panelists are ordinary Sotto threads on their own providers, not OpenRouter calls. Each panelist gets the origin thread's whole conversation, not a brief. The chair sits outside the panel. The view is an ASCII scene in Watcher's style: the panelists as a Roman or Greek council (not owls) around a table with the chair at its head, each one's motion driven by what its thread is doing. Variants: `docs/prototypes/council-chamber-prototype.html`.
