import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { HubArtifactController } from "../src/modules/hub/controllers/hub.controller";

describe("HubArtifactController routes", () => {
  it("serves artifact versions under the artifacts API prefix", () => {
    const method = HubArtifactController.prototype.listArtifactVersions;

    expect(Reflect.getMetadata(PATH_METADATA, HubArtifactController)).toBe("artifacts");
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(":artifactId/versions");
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.GET);
  });
});
