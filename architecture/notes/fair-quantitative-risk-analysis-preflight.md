# FAIR Quantitative Risk Analysis Preflight

Issue: #723
Requirement: GC-T011

This is architecture guardrail guidance for FAIR-aligned quantitative risk
analysis. It is not an implementation plan.

## Primary Sources

- The Open Group Standard, Risk Taxonomy (O-RT), Version 3.0.1 (document C20B).
- The Open Group Standard, Risk Analysis (O-RA), Version 2.0.1 (document C20A).
- The Open Group Guide, The Mathematics of the Open FAIR Methodology, Version
  1.1 (document G262).

These are The Open Group's published documents, available from The Open Group
library; they are cited here, not redistributed in this repository (issue #1589).

## Boundary

GC-T011 is methodology-specific quantitative assessment execution and exposure.
The durable assessment record remains `RiskAssessmentResult`, bound to a
same-project `RiskScenario` and `MethodologyProfile`; the public analysis
surface belongs under `/api/v1/analysis/grc/*` and the consolidated MCP
`gc_analyze` kind set. Do not introduce a parallel FAIR assessment aggregate,
top-level MCP tool, or generic cross-methodology score subsystem.

Keep these concepts distinct:

- `RiskScenario` owns the FAIR-CRST loss-scenario statement (`threat`, `method`,
  `asset`, `effect`, `timeHorizon`) and derived `fairSentence`. It must not grow
  quantitative factor, percentile, or monetary result fields.
- `MethodologyProfile` owns reusable FAIR profile identity, version, factor
  vocabulary, schema surfaces, units, and crosswalk entries. It does not store
  individual estimates or calculation outputs.
- `RiskAssessmentResult` owns the FAIR assessment instance: inputs,
  uncertainty metadata, evidence refs, observation links, computed outputs,
  confidence, analyst identity, timing, and approval state.
- The GRC analysis endpoint is a read/derive surface. Durable writes or edits to
  a FAIR assessment row route through `RiskAssessmentResultService` and the
  existing `/api/v1/risk-assessment-results` contract.

FAIR support must preserve the quantitative decomposition at contract level.
Loss Event Frequency, Loss Magnitude, Threat Event Frequency, Contact Frequency,
Probability of Action, Vulnerability/Susceptibility, Threat Capability,
Resistance Strength, Primary Loss Magnitude, Secondary Loss Event Frequency, and
Secondary Loss Magnitude must remain visible as factors, derived factors, or
explicitly labelled limitations. Collapsing them into only `vulnerability`,
`risk_level`, or `risk_score` does not satisfy GC-T011.

The existing seeded `FAIR_V3_0` profile is a useful substrate, not proof that the
engine exists. It already describes some FAIR inputs and outputs, but GC-T011
requires the implementation to close the gap for Contact Frequency, Probability
of Action, Vulnerability/Susceptibility, Threat Capability, Resistance Strength,
range or distribution estimates, percentile outputs, and monetary reporting.

## Incumbents To Reuse

- Persistence substrate: `RiskAssessmentResult`, `RiskAssessmentResultService`,
  command records, `RiskAssessmentResultRepository`, `MethodologyProfile`,
  `MethodologyProfileService`, project-scoped repository methods, and the
  existing JSON TEXT converters in `JacksonTextCollectionConverters`.
- REST analysis surface: `GrcAnalysisController`, `GrcAnalysisService`, and the
  response-record mapping pattern under `api/grcanalysis`. Follow the existing
  NIST endpoint shape instead of adding a one-off controller or returning domain
  records directly.
- REST assessment CRUD: `RiskAssessmentResultController` remains the durable
  create/update/read surface for stored FAIR inputs, computed outputs, evidence
  refs, observations, confidence, and approval state.
- Methodology seed parity: `V043__create_risk_assessment.sql`,
  `V045__populate_methodology_profile_schemas.sql`, and
  `MethodologyProfileService` default seeding must stay aligned if the FAIR
  profile schema or crosswalk vocabulary changes.
- Evidence and context: use `observationIds`, `evidenceRefs`,
  `RiskScenarioLink`, `FindingLink`, `ControlEffectivenessAssessment`,
  `ControlTest`, `RiskGraphProjectionContributor`, `GraphIds`,
  `GraphEntityType`, and `GraphTargetResolverService` where context is needed.
- MCP surface: extend `gc_analyze` with one new `kind` such as
  `fair_quantitative` and a helper in `mcp/ground-control/lib.js` that calls a
  fixed REST endpoint through `request()`. Keep `gc_risk_governance` for CRUD on
  `risk_assessment_result`.
- Cross-cutting helpers: Bean Validation / `@Validated`, Jackson enum binding,
  domain exceptions, `GlobalExceptionHandler` / `ErrorResponse`,
  `ApiPathMatrix`, security filters, `ActorFilter` / `ActorHolder`,
  `RequestLoggingFilter`, MDC, Envers, Flyway, `@WebMvcTest`, MCP adapter
  tests, ADR-034 mirrors, and `make policy`.

## Cross-Cutting Layers

- Security and authorization: new REST routes stay under `/api/v1/**`. Bearer
  requests pass `IpAllowlistFilter`, `BearerTokenAuthFilter`, Spring
  authorization via `ApiPathMatrix`, then `ActorFilter`; browser/session
  requests pass the browser chain with the same path matrix. Do not add
  route-local authorization, caller-supplied actors, public FAIR endpoints,
  caller-supplied headers, or caller-supplied tokens.
- Request parsing and validation: controller DTO/query annotations own shape
  checks such as UUIDs, ISO instants, positive sample/window limits, and enum
  parsing. Domain services own same-project checks, FAIR-family/profile
  compatibility, required FAIR factor presence, range ordering
  (`low <= likely <= high`), non-negative frequency and loss values,
  probability bounds, distribution parameter validity, currency consistency,
  requested percentile bounds, and whether an output is analyst-supplied,
  persisted, or derived.
- Methodology schema validation: profile schemas exist, but there is no
  canonical JSON Schema validator. If GC-T011 validates `inputFactors` or
  `computedOutputs` against profile schemas, introduce one reusable validation
  component behind the service boundary with one structured
  `DomainValidationException` detail shape. Do not copy schema checks into
  controllers, MCP handlers, migrations, or per-field switch blocks.
- Opaque methodology values: FAIR keys inside `inputFactors`,
  `computedOutputs`, and `uncertaintyMetadata` must remain stable. MCP may
  rename only DTO field names such as `input_factors` to `inputFactors`; it must
  not recursively rewrite FAIR keys such as `contact_frequency`,
  `probability_of_action`, `threat_capability`, `resistance_strength`,
  `primary_loss`, or `secondary_loss`.
- Error envelope: throw `NotFoundException`, `ConflictException`, and
  `DomainValidationException`; `GlobalExceptionHandler` and `ErrorResponse` are
  the only HTTP error shape. Error detail may include stable field paths,
  profile keys, factor names, and valid bounds, but must not echo raw assessment
  inputs, evidence payloads, observation values, headers, stack traces, or
  tokens.
- Logging and audit: Envers plus `ActorFilter`, `ActorHolder`, and
  `GroundControlRevisionListener` provide audit provenance. SLF4J logs should
  use stable IDs, profile keys, derivation method labels, and low-cardinality
  outcome labels only. Never log full FAIR inputs, monetary outputs,
  assumptions, evidence bodies, bearer tokens, session IDs, or random samples.
- Configuration and OS/runtime exposure: GC-T011 should not require new secrets,
  subprocesses, CLI arguments, shell-outs, external network calls, or token-in-
  argv handling. Any future calculation settings use validated
  `@ConfigurationProperties`; any currency conversion or external model is out
  of scope unless a separate trusted integration and secret-handling boundary is
  designed.
- Resource bounds and reproducibility: distribution or Monte Carlo support must
  have bounded sample counts, bounded percentile lists, and explicit
  `derivationMethod` / simulation settings in the response. If stochastic
  computation affects business-facing output, the seed or persisted computed
  outputs must be visible enough to make the result explainable.
- MCP validation and transport: public MCP args stay snake_case and Zod checked.
  Use `request()`, `buildUrl`, `addAuthorizationHeader`, `RequestError`, `pick`,
  and the shared snake/camel mapping. Do not add per-tool fetch clients, absolute
  URLs, caller-supplied auth, shell-outs, direct database reads, or MCP-local
  FAIR execution.
- Persistence and migrations: new columns or audited entities require Flyway,
  audit-table parity, indexes for primary reads, migration smoke updates, and
  audit-retention review. Prefer profile-data/schema changes and
  `RiskAssessmentResult` value bags before adding storage. Do not add a FAIR-
  only table unless the existing assessment aggregate cannot represent a
  durable business fact.
- Contract mirrors and policy: new API-visible enums such as FAIR factor
  identifiers, estimate kinds, distribution families, output scales, or analysis
  kinds must follow ADR-034: backend enum as authority, MCP constants/Zod,
  frontend types/constants where mirrored, docs, and policy inventory or
  focused mirror tests together.

## FAIR Result Contract Guardrails

The analysis response must be structured for agent use and methodology
attributed. It should carry `analysisKind`, `project`, `asOf`,
`methodologyProfileId` / `profileKey` / `family` / `version`,
`derivationMethod`, `scale`, `units`, structured `inputs`, structured
`outputs`, `evidence`, and `limitations`.

For FAIR, `inputs` must preserve at least:

- Threat Event Frequency and its factor lineage: Contact Frequency and
  Probability of Action when supplied or derivable.
- Vulnerability or Susceptibility, with Threat Capability and Resistance
  Strength preserved when supplied or derivable.
- Primary Loss and Secondary Loss factors, including currency and whether values
  are range-based or distribution-based estimates.
- Confidence or uncertainty metadata per factor.
- Evidence references, observation links, assessment timeframe, and any
  assumptions needed to understand the calculation.

`outputs` must preserve Loss Event Frequency, Probable Loss Magnitude, annualized
loss or equivalent monetary reporting, requested percentiles, currency, and
derivation labels. A qualitative communication label may be included only as a
secondary field with method attribution; it must not replace monetary and
frequency outputs.

`limitations` must be explicit when profile schema validation was not performed,
factor lineage is incomplete, only one member of a lower-level factor pair is
present, TCap/RS are present but no distribution calculation for `P(TCap > RS)`
is performed, currencies are mixed or not converted, evidence is stale or
missing, or distribution output is persisted rather than recomputed. Direct
Threat Event Frequency and direct Vulnerability estimates are valid higher-level
Open FAIR estimates and must not be flagged merely because lower-level factors
are absent.

## Extensibility

The extension seam is a methodology-aware FAIR analysis service behind
`GrcAnalysisService`, keyed by project plus `riskAssessmentResultId` or
scenario/profile selection. The next reasonable variation is another FAIR
profile version, an organization-specific distribution vocabulary, a requested
percentile set, or a different monetary reporting currency. Those should
require profile data, a bounded service handler, and tests, not new MCP
transport, auth rules, error envelopes, graph clients, or persistence
aggregates.

Parameterize the seam by `project`, `asOf`, `riskAssessmentResultId`,
`riskScenarioId`, optional methodology profile identity, requested percentiles,
and reporting currency if conversion is actually supported. If conversion is
not supported, reject mixed currencies or return a limitation rather than
silently normalizing values.

Local typed value records inside the FAIR service are acceptable for parsing and
calculation. Do not promote them into repo-wide abstractions unless at least one
other methodology really reuses them; three clear FAIR-specific records beat a
premature generic risk-estimate framework.

## Gotchas And Anti-Patterns

- Do not treat the existing seeded `FAIR_V3_0` schema as the FAIR quantitative
  engine.
- Do not store FAIR factors, ALE, percentiles, or loss magnitude on
  `RiskScenario`, `RiskRegisterRecord`, `TreatmentPlan`, `Control`, or
  `OperationalAsset`.
- Do not collapse FAIR monetary outputs, NIST ordinal bands, ISO scores,
  evidence freshness, or vendor rollups into a generic `risk_score`.
- Do not conflate FAIR-CRST scenario fields with quantitative factors:
  `RiskScenario.threat` is not Threat Capability, `method` is not Contact
  Frequency, and `effect` is not Primary Loss Magnitude.
- Do not treat `ControlStatus.OPERATIONAL` as Resistance Strength or
  susceptibility evidence. Use `ControlTest` and
  `ControlEffectivenessAssessment`, and surface limitations when control
  evidence is incomplete.
- Do not recursively rename methodology-defined value-bag keys across MCP
  transport.
- Do not add a new top-level MCP tool, generic API passthrough, Cypher/SQL
  passthrough, direct AGE writes, duplicate error envelope, duplicate auth
  filter, duplicate JSON parser, duplicate exception hierarchy, or MCP-local
  calculation engine.
- Do not shell out to calculators, scripts, notebooks, or network services from
  the backend or MCP adapter to compute FAIR outputs.
- Do not compare FAIR dollar loss to NIST qualitative risk levels without an
  explicit method label and conversion rule.

## Non-Goals

- No implementation of GC-T011 in this preflight.
- No new FAIR-only persistence aggregate, graph subsystem, workflow engine, auth
  model, secret/config namespace, external currency feed, or OpenAPI/codegen
  migration.
- No changes to GC-T013 FAIR-CRST scenario taxonomy, GC-T014 NIST assessment
  semantics, GC-L007 evidence/vendor analyses, or GRC screening workflow records
  beyond preserving their boundaries.
- No claim that schema persistence alone satisfies FAIR quantitative execution.
