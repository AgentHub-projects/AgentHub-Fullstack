import { describe, expect, it } from "vitest";
import { parseDeploymentCommandTarget } from "../src/modules/hub/services/hub-session.service";

describe("HubSessionService deployment command parsing", () => {
  it("maps chat deployment commands to deployment targets", () => {
    expect(parseDeploymentCommandTarget("部署")).toBe("static");
    expect(parseDeploymentCommandTarget("请部署到容器")).toBe("container");
    expect(parseDeploymentCommandTarget("源码打包")).toBe("source_archive");
    expect(parseDeploymentCommandTarget("deploy container")).toBe("container");
    expect(parseDeploymentCommandTarget("帮我解释一下部署流程，这不是触发部署")).toBeNull();
  });
});
