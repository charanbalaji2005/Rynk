import { cmd, type CommandSpec, type DetectionResult } from "@rynk/core";
import type { Detector } from "../detector.js";
import { isWindows, type ProjectContext } from "../context.js";

export const javaDetector: Detector = {
  name: "java",
  detect(ctx: ProjectContext): DetectionResult | null {
    const pom = ctx.read("pom.xml");
    const gradle = ctx.read("build.gradle") ?? ctx.read("build.gradle.kts");
    if (pom === null && gradle === null) return null;
    const text = `${pom ?? ""}\n${gradle ?? ""}`;
    const spring = /spring-boot/.test(text);
    const kotlin = /kotlin/.test(text) || ctx.exists("build.gradle.kts");
    const quarkus = /io\.quarkus/.test(text);
    const warnings: string[] = [];
    let start: CommandSpec | undefined;

    if (pom !== null) {
      const mvn = ctx.exists(isWindows ? "mvnw.cmd" : "mvnw") ? (isWindows ? "mvnw.cmd" : "./mvnw") : "mvn";
      start = spring ? cmd(mvn, "spring-boot:run") : quarkus ? cmd(mvn, "quarkus:dev") : undefined;
    } else {
      const gw = ctx.exists(isWindows ? "gradlew.bat" : "gradlew") ? (isWindows ? "gradlew.bat" : "./gradlew") : "gradle";
      start = spring ? cmd(gw, "bootRun") : quarkus ? cmd(gw, "quarkusDev") : cmd(gw, "run");
    }
    if (!start) warnings.push("Plain Maven project: add a start command in rynk.yaml (e.g. java -jar target/app.jar).");

    return {
      detector: "java",
      language: kotlin ? "kotlin" : "java",
      runtime: "native",
      confidence: start ? (spring || quarkus ? 0.9 : 0.7) : 0.35,
      evidence: [pom !== null ? "pom.xml" : "build.gradle", ...(spring ? ["spring-boot"] : []), ...(quarkus ? ["quarkus"] : [])],
      ...(spring ? { framework: "Spring Boot" } : quarkus ? { framework: "Quarkus" } : {}),
      ...(start ? { start } : {}),
      binding: spring
        ? { env: { SERVER_PORT: "{port}", SERVER_ADDRESS: "{host}" }, portControllable: true }
        : quarkus
          ? { env: { QUARKUS_HTTP_PORT: "{port}", QUARKUS_HTTP_HOST: "{host}" }, portControllable: true }
          : { env: { PORT: "{port}" }, portControllable: false },
      defaultPort: 8080,
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
