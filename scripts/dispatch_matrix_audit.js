import "../loadEnv.js";
import { runDispatchMatrixAudit } from "../services/dispatchMatrixAudit.js";

function parseArgs(argv) {
  const args = {
    json: false,
    simulateReady: false,
    includePassing: false,
    serviceDomains: null,
    vehicleTypes: null,
  };

  argv.forEach((arg) => {
    if (arg === "--json") args.json = true;
    if (arg === "--simulate-ready") args.simulateReady = true;
    if (arg === "--include-passing") args.includePassing = true;
    if (arg.startsWith("--service-domains=")) {
      args.serviceDomains = arg
        .split("=")[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (arg.startsWith("--vehicle-types=")) {
      args.vehicleTypes = arg
        .split("=")[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  });

  return args;
}

function printHuman(report, includePassing) {
  console.log("=== DISPATCH MATRIX AUDIT ===");
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Simulate Ready: ${report.options.simulate_ready ? "yes" : "no"}`);
  console.log(
    `Dimensions: services=${report.dimensions.service_domains.length}, vehicles=${report.dimensions.vehicle_types.length}, combinations=${report.dimensions.total_combinations}`
  );

  const pool = report.technician_pool;
  console.log("\nTechnician Pool:");
  console.log(
    `  total=${pool.total}, approved=${pool.approved}, active=${pool.active}, available=${pool.available}, approved+active+available=${pool.approved_active_available}`
  );
  console.log(
    `  with_coords=${pool.with_valid_coords}, missing_service_profile=${pool.missing_service_profile}, missing_vehicle_profile=${pool.missing_vehicle_profile}`
  );

  const s = report.summary;
  console.log("\nSummary:");
  console.log(
    `  pass=${s.pass_count}, missing=${s.missing_count}, no_configured=${s.no_configured_count}, configured_but_not_dispatchable=${s.configured_but_not_dispatchable_count}`
  );

  const rows = includePassing ? report.matrix : report.missing_coverage;
  if (rows.length === 0) {
    console.log("\nNo missing coverage found.");
    return;
  }

  console.log(`\n${includePassing ? "Matrix" : "Missing Coverage"}:`);
  rows.forEach((row) => {
    const topReasons = (row.rejection_reasons || [])
      .slice(0, 3)
      .map((r) => `${r.reason}:${r.count}`)
      .join(", ");
    console.log(
      `  ${row.service_domain}|${row.vehicle_type} -> ${row.status} (configured=${row.configured_technicians}, ready=${row.ready_technicians}, eligible_now=${row.eligible_technicians_now})${topReasons ? ` reasons=[${topReasons}]` : ""}`
    );
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runDispatchMatrixAudit({
    serviceDomains: args.serviceDomains || undefined,
    vehicleTypes: args.vehicleTypes || undefined,
    simulateReady: args.simulateReady,
  });

  if (args.json) {
    const payload = args.includePassing
      ? report
      : {
          ...report,
          matrix: report.missing_coverage,
        };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(report, args.includePassing);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Dispatch Matrix Audit] Failed:", err?.message || err);
    process.exit(1);
  });

