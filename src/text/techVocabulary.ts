/**
 * One curated vocabulary of technologies, practices and named products, with
 * the spellings postings, resumes and letters use for them. Evaluation and
 * analytics count the skills in it; the document fact check reads its names.
 *
 * Deliberately conservative: a term reported as a gap the candidate must not
 * claim has to be a real skill, so only recognisable technologies are listed.
 * A name that is also an ordinary English word matches only as written.
 */

export type TechCategory =
  | "language"
  | "frontend"
  | "backend"
  | "mobile"
  | "cloud"
  | "infra"
  | "observability"
  | "database"
  | "data"
  | "ml"
  | "security"
  | "practice"
  | "embedded"
  | "testing"
  /** Named products and umbrella brands (GitHub, Jira, Apache): checked as names, never reported as a skill. */
  | "product";

export type TermForm = {
  text: string;
  caseSensitive: boolean;
  /** An everyday word ("Go", "Spark"): counts only mid-sentence or as a list item, never as "React to incidents". */
  ordinaryWord: boolean;
};

export type TechTerm = {
  term: string;
  category: TechCategory;
  aliases: readonly string[];
  /** The term's own spelling matches only as written. */
  caseSensitive: boolean;
  /** A practice or field ("observability", "machine learning") rather than a named technology. */
  concept: boolean;
  /** Every spelling searched for, plurals included. */
  forms: readonly TermForm[];
};

/** `cs`: case-sensitive; `word`: an everyday word, case-sensitive and never sentence-initial; `concept`: a practice, not a name. */
type Flag = "cs" | "word" | "concept";

/**
 * An alias is case-sensitive when written with a leading "=" ("=Node") and an
 * everyday word when written with "~"; most aliases ("Golang", "Spring Boot")
 * are unambiguous in any case.
 */
function t(term: string, category: TechCategory, aliases: readonly string[] = [], flag?: Flag): TechTerm {
  const spelled: TermForm[] = [
    { text: term, caseSensitive: flag === "cs" || flag === "word", ordinaryWord: flag === "word" },
    ...aliases.map((alias) => ({ text: alias.replace(/^[=~]/, ""), caseSensitive: /^[=~]/.test(alias), ordinaryWord: alias.startsWith("~") })),
  ];
  const forms = spelled
    .flatMap((form) => (form.text.length >= 3 && /[a-z]$/i.test(form.text) && !/s$/i.test(form.text) ? [form, { ...form, text: `${form.text}s` }] : [form]))
    .filter((form, index, all) => all.findIndex((other) => other.text === form.text && other.caseSensitive === form.caseSensitive) === index);
  return {
    term,
    category,
    aliases: spelled.slice(1).map((form) => form.text),
    caseSensitive: flag === "cs" || flag === "word",
    concept: flag === "concept",
    forms,
  };
}

export const TECH_TERMS: readonly TechTerm[] = [
  // Languages
  t("Python", "language"), t("Java", "language"), t("JavaScript", "language", ["=JS", "ECMAScript"]),
  t("TypeScript", "language"), t("Go", "language", ["Golang"], "word"), t("Rust", "language", [], "cs"),
  t("C++", "language", ["CPP"]), t("C#", "language", ["CSharp"]), t("Ruby", "language"), t("Scala", "language"),
  t("Kotlin", "language"), t("Swift", "language", [], "word"), t("Objective-C", "language"), t("PHP", "language"),
  t("Perl", "language"), t("Haskell", "language"), t("Elixir", "language"), t("Erlang", "language"),
  t("Clojure", "language"), t("Dart", "language", [], "cs"), t("Lua", "language"), t("MATLAB", "language"),
  t("Bash", "language", ["shell scripting"]), t("PowerShell", "language"), t("Solidity", "language"),
  t("OCaml", "language"), t("F#", "language"), t("Groovy", "language"), t("SQL", "language", [], "cs"),
  t("Zig", "language", [], "cs"), t("Julia", "language", [], "cs"), t("Elm", "language", [], "cs"), t("Fortran", "language"),
  // Frontend
  t("React", "frontend", ["React.js", "ReactJS"], "word"), t("Angular", "frontend", ["AngularJS"]), t("Vue", "frontend", ["Vue.js", "VueJS"]),
  t("Svelte", "frontend"), t("Next.js", "frontend", ["NextJS"]), t("Redux", "frontend"), t("Tailwind", "frontend", ["Tailwind CSS", "TailwindCSS"], "cs"),
  t("HTML", "frontend", ["HTML5"], "cs"), t("CSS", "frontend", ["CSS3"], "cs"), t("jQuery", "frontend"), t("Webpack", "frontend"),
  t("WebAssembly", "frontend", ["Wasm"]), t("WebRTC", "frontend"), t("D3.js", "frontend", ["=D3"]),
  t("Unity", "frontend", [], "word"), t("Unreal Engine", "frontend", ["Unreal"]),
  // Backend
  t("Node.js", "backend", ["NodeJS", "=Node"]), t("Express", "backend", ["Express.js", "ExpressJS"], "word"), t("Django", "backend"),
  t("Flask", "backend"), t("FastAPI", "backend"), t("Spring", "backend", ["Spring Boot", "SpringBoot", "Spring Framework"], "word"),
  t("Ruby on Rails", "backend", ["=Rails"]), t("Laravel", "backend"), t(".NET", "backend", ["dotnet", ".NET Core"], "cs"),
  t("ASP.NET", "backend"), t("gRPC", "backend"), t("GraphQL", "backend"), t("REST", "backend", ["RESTful", "REST APIs"], "cs"),
  t("NestJS", "backend"), t("Protobuf", "backend", ["protocol buffers"]), t("WebSockets", "backend", ["WebSocket"]),
  t("OpenAPI", "backend", ["Swagger"]), t("Celery", "backend", [], "cs"), t("Deno", "backend"), t("Bun", "backend", [], "cs"),
  t("Kong", "backend", [], "cs"), t("microservices", "practice", ["microservice", "micro-services"], "concept"),
  t("blockchain", "backend", ["smart contracts"], "concept"),
  // Mobile
  t("iOS", "mobile", [], "cs"), t("Android", "mobile"), t("React Native", "mobile"), t("Flutter", "mobile"),
  t("SwiftUI", "mobile"), t("Jetpack Compose", "mobile"), t("Xcode", "mobile"),
  // Cloud
  t("AWS", "cloud", ["Amazon Web Services"]), t("GCP", "cloud", ["Google Cloud", "Google Cloud Platform"]),
  t("Azure", "cloud", ["Microsoft Azure"]), t("EC2", "cloud"), t("S3", "cloud", [], "cs"), t("Lambda", "cloud", ["AWS Lambda"], "cs"),
  t("EKS", "cloud", [], "cs"), t("ECS", "cloud", [], "cs"), t("GKE", "cloud", [], "cs"), t("AKS", "cloud", [], "cs"),
  t("CloudFormation", "cloud"), t("Cloudflare", "cloud"), t("serverless", "cloud", [], "concept"), t("VPC", "cloud", [], "cs"),
  t("Heroku", "cloud"), t("Netlify", "cloud"), t("Vercel", "cloud"), t("Firebase", "cloud"),
  // Infrastructure and delivery
  t("Kubernetes", "infra", ["K8s"]), t("Docker", "infra", ["containerization"]), t("Terraform", "infra"),
  t("Pulumi", "infra"), t("Ansible", "infra"), t("Chef", "infra", [], "cs"), t("Puppet", "infra", [], "cs"), t("Helm", "infra", [], "cs"),
  t("Istio", "infra"), t("Linkerd", "infra"), t("Envoy", "infra", [], "cs"), t("service mesh", "infra", [], "concept"),
  t("Linux", "infra"), t("Unix", "infra"), t("Nginx", "infra"), t("Jenkins", "infra"), t("GitHub Actions", "infra"),
  t("GitLab CI", "infra", ["GitLab"]), t("CircleCI", "infra"), t("Argo CD", "infra", ["ArgoCD", "Argo Workflows", "=Argo"]),
  t("Git", "infra", [], "cs"), t("Bazel", "infra"), t("Nomad", "infra", [], "cs"), t("Consul", "infra", [], "cs"),
  t("Vault", "infra", ["HashiCorp Vault"], "cs"), t("Packer", "infra", [], "cs"), t("Vagrant", "infra"), t("Salt", "infra", ["SaltStack"], "word"),
  t("Nix", "infra", ["NixOS"], "cs"), t("OpenShift", "infra"), t("ZooKeeper", "infra"), t("eBPF", "infra"), t("VMware", "infra"),
  t("CI/CD", "practice", ["CICD", "continuous integration", "continuous delivery", "continuous deployment"]),
  t("infrastructure as code", "practice", ["IaC"], "concept"), t("SRE", "practice", ["site reliability", "site reliability engineering"], "cs"),
  t("DNS", "infra", [], "cs"), t("TCP/IP", "infra"), t("CDN", "infra", [], "cs"), t("load balancing", "infra", ["load balancers", "load balancer"], "concept"),
  t("networking", "infra", ["BGP"], "concept"), t("virtualization", "infra", ["hypervisor"], "concept"),
  // Observability
  t("Prometheus", "observability"), t("Grafana", "observability"), t("Datadog", "observability"), t("Splunk", "observability"),
  t("ELK", "observability", ["Elastic Stack"], "cs"), t("Kibana", "observability"), t("DevOps", "practice"),
  t("OpenTelemetry", "observability", ["OTel"]), t("New Relic", "observability"), t("PagerDuty", "observability"),
  t("Sentry", "observability", [], "cs"), t("observability", "practice", [], "concept"), t("chaos engineering", "practice", [], "concept"),
  // Databases
  t("NoSQL", "database"), t("PostgreSQL", "database", ["Postgres"]), t("MySQL", "database"), t("SQL Server", "database", ["MSSQL"]),
  t("Oracle", "database", [], "cs"), t("MongoDB", "database", ["Mongo"]), t("Redis", "database"), t("Cassandra", "database"),
  t("DynamoDB", "database"), t("Elasticsearch", "database", ["OpenSearch", "Elastic Search"]), t("ClickHouse", "database"),
  t("SQLite", "database"), t("Neo4j", "database"), t("CockroachDB", "database"), t("Spanner", "database", [], "cs"),
  t("Memcached", "database"), t("Aurora", "database", ["Amazon Aurora"], "cs"), t("Druid", "database", ["Apache Druid"], "cs"),
  // Data
  t("Kafka", "data", ["Apache Kafka"]), t("RabbitMQ", "data"), t("Kinesis", "data"), t("Pub/Sub", "data"), t("SQS", "data", [], "cs"),
  t("Spark", "data", ["Apache Spark", "PySpark", "Spark Streaming"], "word"), t("Hadoop", "data"), t("Hive", "data", ["Apache Hive"], "cs"),
  t("Airflow", "data", ["Apache Airflow"]), t("dbt", "data", [], "cs"), t("Flink", "data", ["Apache Flink"]),
  t("Beam", "data", ["Apache Beam"], "word"), t("Storm", "data", ["Apache Storm"], "word"), t("Pulsar", "data", ["Apache Pulsar"], "cs"),
  t("Databricks", "data"), t("Snowflake", "data"), t("BigQuery", "data"), t("Redshift", "data"), t("Trino", "data", ["Presto"]),
  t("Looker", "data"), t("Tableau", "data"), t("Power BI", "data"), t("ETL", "data", ["ELT"], "cs"),
  t("data pipelines", "data", ["data pipeline"], "concept"), t("data warehouse", "data", ["data warehousing"], "concept"),
  t("data modeling", "data", ["data modelling"], "concept"), t("stream processing", "data", ["real-time streaming"], "concept"),
  t("pandas", "data", ["=Pandas"], "cs"), t("NumPy", "data"),
  // Machine learning
  t("machine learning", "ml", ["=ML"], "concept"), t("deep learning", "ml", [], "concept"), t("PyTorch", "ml"), t("TensorFlow", "ml"),
  t("JAX", "ml", [], "cs"), t("scikit-learn", "ml", ["sklearn"]), t("Keras", "ml"), t("Hugging Face", "ml", ["HuggingFace"]),
  t("LLM", "ml", ["LLMs", "large language model", "large language models"]), t("RAG", "ml", ["retrieval-augmented generation"], "cs"),
  t("NLP", "ml", ["natural language processing"]), t("computer vision", "ml", [], "concept"), t("MLOps", "ml"), t("LangChain", "ml"),
  t("LlamaIndex", "ml"), t("vector databases", "ml", ["vector database", "vector store", "vector search", "vector DB"], "concept"),
  t("embeddings", "ml", ["vector embeddings"], "concept"), t("fine-tuning", "ml", ["finetuning"], "concept"),
  t("reinforcement learning", "ml", ["RLHF"], "concept"), t("CUDA", "ml"), t("prompt engineering", "ml", [], "concept"),
  t("generative AI", "ml", ["GenAI", "gen AI"], "concept"), t("MLflow", "ml"), t("XGBoost", "ml"), t("Jupyter", "ml"),
  t("agentic", "ml", ["AI agents", "multi-agent", "LLM agents"], "concept"), t("Kubeflow", "ml"), t("SageMaker", "ml"),
  t("Vertex AI", "ml"), t("Amazon Bedrock", "ml", ["AWS Bedrock"]), t("GPU", "ml"),
  t("recommender systems", "ml", ["recommendation systems", "recommendation engine"], "concept"),
  // Security
  t("threat modeling", "security", ["threat modelling", "threat model"], "concept"),
  t("penetration testing", "security", ["pentesting", "pen testing", "pentest"], "concept"),
  t("vulnerability management", "security", ["vulnerability scanning"], "concept"), t("incident response", "security", [], "concept"),
  t("SIEM", "security"), t("SOAR", "security", [], "cs"), t("EDR", "security", ["endpoint detection"], "cs"), t("XDR", "security", [], "cs"),
  t("zero trust", "security", [], "concept"), t("OAuth", "security", ["OAuth2", "OAuth 2.0"]), t("OIDC", "security", ["OpenID Connect"]),
  t("SAML", "security"), t("SSO", "security", ["single sign-on"], "cs"), t("PKI", "security", [], "cs"), t("TLS", "security", ["SSL/TLS"], "cs"),
  t("cryptography", "security", ["encryption", "key management"], "concept"),
  t("application security", "security", ["AppSec", "product security"], "concept"), t("cloud security", "security", [], "concept"),
  t("network security", "security", [], "concept"), t("container security", "security", [], "concept"),
  t("detection engineering", "security", [], "concept"), t("threat intelligence", "security", ["threat intel"], "concept"),
  t("threat hunting", "security", [], "concept"), t("malware analysis", "security", [], "concept"),
  t("reverse engineering", "security", [], "concept"), t("fuzzing", "security", [], "concept"), t("SOC 2", "security", ["SOC2"]),
  t("ISO 27001", "security"), t("FedRAMP", "security"), t("HIPAA", "security"), t("PCI DSS", "security", ["=PCI"]), t("GDPR", "security"),
  t("NIST", "security", [], "cs"), t("OWASP", "security"), t("SAST", "security", ["static analysis"], "cs"), t("DAST", "security", [], "cs"),
  t("secure code review", "security", ["security code review"], "concept"), t("red teaming", "security", ["red team"], "concept"),
  t("IAM", "security", ["identity and access management", "access management"], "cs"), t("MFA", "security", ["multi-factor authentication"], "cs"),
  t("Open Policy Agent", "security", ["=OPA"]), t("policy as code", "security", ["=Rego"], "concept"), t("WAF", "security", ["web application firewall"], "cs"),
  t("CSPM", "security", ["CNAPP", "CWPP"], "cs"), t("Burp Suite", "security"), t("Metasploit", "security"), t("Wireshark", "security"),
  t("Snyk", "security"), t("Semgrep", "security"), t("CodeQL", "security"), t("CrowdStrike", "security"), t("Okta", "security"),
  t("Zscaler", "security"), t("Wiz", "security", [], "cs"), t("DevSecOps", "security"),
  t("SBOM", "security", ["software supply chain security", "supply chain security", "SLSA"]),
  t("AI security", "security", ["AI safety"], "concept"), t("guardrails", "security", ["guardrail"], "concept"),
  // Engineering practices
  t("distributed systems", "practice", ["distributed system", "distributed computing"], "concept"),
  t("system design", "practice", ["systems design"], "concept"), t("API design", "practice", [], "concept"),
  t("event-driven", "practice", ["event sourcing"], "concept"), t("TDD", "practice", ["test-driven development"], "cs"),
  t("performance optimization", "practice", ["performance tuning"], "concept"), t("high availability", "practice", [], "concept"),
  t("scalability", "practice", [], "concept"), t("A/B testing", "practice", ["experimentation"], "concept"),
  // Testing
  t("Cypress", "testing"), t("Jest", "testing", [], "cs"), t("Mocha", "testing", [], "cs"), t("Playwright", "testing"), t("Selenium", "testing"),
  // Embedded and hardware
  t("embedded systems", "embedded", ["embedded software"], "concept"), t("firmware", "embedded", [], "concept"), t("RTOS", "embedded"),
  t("FPGA", "embedded", [], "cs"), t("Verilog", "embedded", ["SystemVerilog"]), t("VHDL", "embedded"),
  // Named products: a letter may not claim them unsupported, but a posting naming them is not asking for a skill
  t("GitHub", "product"), t("Bitbucket", "product"), t("Jira", "product"), t("Confluence", "product", [], "cs"),
  t("Notion", "product", [], "word"), t("Apache", "product", [], "cs"), t("Elastic", "product", [], "word"),
];

/** The terms that are skills: everything but the named products. */
export const SKILL_TERMS: readonly TechTerm[] = TECH_TERMS.filter((term) => term.category !== "product");
