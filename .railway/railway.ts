import { defineRailway, github, postgres, project, service, volume } from "railway/iac";

// See RAILWAY.md. Variables are set in Railway (unmanaged here), so secrets never live in the repo.
const REGION = "asia-southeast1-eqsg3a"; // Singapore: closest to Pakistan
const GB = 1024 ** 3;

export default defineRailway(() => {
  const repo = github("inamullahshaikh/taysha-bms", { branch: "main", checkSuites: false });
  const build = {
    builder: "DOCKERFILE" as const,
    dockerfilePath: "Dockerfile",
    watchPatterns: ["/backend/**", "/frontend/**", "/Dockerfile"], // editing docs doesn't redeploy
  };

  const Postgres = postgres("Postgres", { region: REGION });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: REGION, sizeMB: 5000,
  });
  const appData = volume("app-data", { alerts: { usage: { "80": {}, "95": {} } }, region: REGION });

  // API under /api and the built frontend
  const app = service("app", {
    source: repo,
    build,
    deploy: {
      preDeployCommand: ["alembic upgrade head"], // migrations once per deploy, not on every start
      healthcheckPath: "/api/health",
      limitOverride: { containers: { cpu: 1, memoryBytes: 1 * GB } },
    },
    replicas: { [REGION]: 1 },
    volumeMounts: { "app-data": { mountPath: "/data", backupSchedules: ["DAILY"] } },
  });

  // background jobs: runs whatever is due, then exits
  const jobs = service("jobs", {
    source: repo,
    build,
    deploy: {
      startCommand: "python -m app.jobs",
      cronSchedule: "*/15 * * * *",
      restartPolicyType: "NEVER",
      limitOverride: { containers: { cpu: 1, memoryBytes: 0.5 * GB } },
    },
    replicas: { [REGION]: 1 },
  });

  return project("taysha-bms", {
    variables: { managed: false },
    resources: [app, Postgres, jobs, postgresVolume, appData],
  });
});
