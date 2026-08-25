/** Pi package entrypoint declared by package.json#pi.extensions. */
import { StringEnum } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveCodexAuth } from "./src/auth/codex-auth.ts";
import {
	CodexImagesClient,
	FetchHttpTransport,
} from "./src/client/codex-images.ts";
import { ExtensionError, cancelledError } from "./src/errors.ts";
import {
	DefaultImageGenerator,
	type GeneratedImage,
	type ImageGenerator,
} from "./src/image-generator.ts";
import {
	ReferenceImagePlanner,
	type PlannedReferenceImages,
	type ReferenceImagePlanning,
} from "./src/input/reference-images.ts";
import { ImageStore } from "./src/output/image-store.ts";
import { requiresExternalOutputPathApproval } from "./src/output/paths.ts";
import type { GenerateImageRequest } from "./src/types.ts";

const PARAMETERS = Type.Object(
	{
		prompt: Type.String({
			description:
				"A concise natural-language description of the new image or requested edit.",
		}),
		referencedImagePaths: Type.Optional(
			Type.Array(
				Type.String({
					description:
						"Local PNG, JPEG, or WebP path to upload as an edit/reference input.",
				}),
				{
					minItems: 0,
					maxItems: 5,
					description:
						"One to five local images. When provided, the tool edits or derives from these images.",
				},
			),
		),
		outputPath: Type.Optional(
			Type.String({
				description:
					"Exact PNG destination. Relative paths must stay inside the current project.",
			}),
		),
		save: Type.Optional(
			StringEnum(["auto", "none", "project", "global"] as const, {
				description:
					"Where to save the PNG. auto uses the current project; global uses the Prime Agent directory.",
			}),
		),
		size: Type.Optional(
			StringEnum(["auto", "1024x1024", "1536x1024", "1024x1536"] as const),
		),
		quality: Type.Optional(
			StringEnum(["auto", "low", "medium", "high"] as const),
		),
	},
	{ additionalProperties: false },
);

function productionGenerator(): ImageGenerator {
	return new DefaultImageGenerator({
		resolveAuth: (registry) => resolveCodexAuth(registry as ModelRegistry),
		client: new CodexImagesClient(new FetchHttpTransport()),
		store: new ImageStore(),
	});
}

/** Resolve Prime's real agent directory without importing Pi's package config. */
export function resolvePrimeAgentDir(
	environment: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const configured = environment.PRIME_AGENT_CODING_AGENT_DIR?.trim();
	return resolve(configured || resolve(home, ".prime", "agent"));
}

export function createCodexImageExtension(
	generator: ImageGenerator = productionGenerator(),
	referencePlanner: ReferenceImagePlanning = new ReferenceImagePlanner(),
	agentDir: string = resolvePrimeAgentDir(),
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "codex_generate_image",
			label: "Codex Generate Image",
			description:
				"Generate or edit one PNG with gpt-image-2 through the ChatGPT-backed Codex Images flow used by Codex CLI. Provide referencedImagePaths to edit or derive from one to five local PNG, JPEG, or WebP images.",
			promptSnippet: "Generate or edit one PNG through the Codex Images flow",
			promptGuidelines: [
				"Use codex_generate_image when a generated or edited raster image materially helps the task; it sends a real request through the user's Codex login, so avoid redundant calls.",
				"Pass referencedImagePaths to codex_generate_image only for local images the user explicitly wants uploaded to Codex as edit/reference inputs.",
				"Pass outputPath to codex_generate_image only when the user requests a destination.",
			],
			parameters: PARAMETERS,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const request: GenerateImageRequest = { ...params };
				if (request.referencedImagePaths?.length === 0) {
					delete request.referencedImagePaths;
				}
				const pathContext = {
					cwd: ctx.cwd,
					agentDir,
					sessionId: ctx.sessionManager.getSessionId(),
					// Prime's selected cwd is the explicit project boundary. Containment
					// and symlink revalidation remain enforced by the upstream store.
					projectTrusted: true,
				};
				let referenceImages: PlannedReferenceImages | undefined;
				let referenceUploadApproved = false;
				if (request.referencedImagePaths !== undefined) {
					try {
						referenceImages = await referencePlanner.plan(
							request.referencedImagePaths,
							pathContext,
						);
					} catch (error) {
						if (error instanceof ExtensionError) throw toolError(error);
						throw toolError(
							new ExtensionError(
								"INPUT_IMAGE_INVALID",
								"Reference images could not be prepared.",
							),
						);
					}
					if (!ctx.hasUI) {
						throw toolError(
							new ExtensionError(
								"INPUT_IMAGE_APPROVAL_REQUIRED",
								"Uploading local reference images requires interactive approval.",
							),
						);
					}
					referenceUploadApproved = await ctx.ui.confirm(
						`Upload ${referenceImages.count} local image${referenceImages.count === 1 ? "" : "s"} to Codex?`,
						`These files will leave this machine and be sent to Codex using the current Codex login:\n${referenceImages.displayPaths.join("\n")}`,
					);
					if (!referenceUploadApproved) throw toolError(cancelledError());
				}

				let externalOutputPathApproved = false;
				if (requiresExternalOutputPathApproval(request, pathContext)) {
					if (!ctx.hasUI) {
						throw toolError(
							new ExtensionError(
								"INVALID_REQUEST",
								"An absolute outputPath outside Prime or the current project requires interactive approval.",
							),
						);
					}
					externalOutputPathApproved = await ctx.ui.confirm(
						"Allow image output outside safe roots?",
						`Save the generated PNG to ${request.outputPath}?`,
					);
					if (!externalOutputPathApproved) throw toolError(cancelledError());
				}

				onUpdate?.({
					content: [
						{
							type: "text",
							text: referenceImages
								? "Editing one PNG through Codex Images..."
								: "Generating one PNG through Codex Images...",
						},
					],
					details: {},
				});
				try {
					const image = await generator.generate(request, {
						...pathContext,
						modelRegistry: ctx.modelRegistry,
						signal: signal ?? ctx.signal,
						externalOutputPathApproved,
						referenceImages,
						referenceUploadApproved,
					});
					return toolResult(image, referenceImages !== undefined);
				} catch (error) {
					if (error instanceof ExtensionError) throw toolError(error);
					throw toolError(
						new ExtensionError(
							"BACKEND_UNAVAILABLE",
							"Image generation failed unexpectedly.",
						),
					);
				}
			},
		});
	};
}

function toolResult(image: GeneratedImage, edited = false) {
	const verb = edited ? "Edited" : "Generated";
	const text = image.savedPath
		? `${verb} PNG with ${image.model} and saved it to ${image.savedPath}.`
		: `${verb} PNG with ${image.model} without saving it.`;
	const details: Record<string, string | number> = {
		model: image.model,
		mimeType: image.mimeType,
	};
	if (image.savedPath !== undefined) details.savedPath = image.savedPath;
	if (image.created !== undefined) details.created = image.created;
	if (image.quality !== undefined) details.quality = image.quality;
	if (image.size !== undefined) details.size = image.size;
	return {
		content: [
			{ type: "text" as const, text },
			{ type: "image" as const, data: image.base64, mimeType: image.mimeType },
		],
		details,
	};
}

function toolError(error: ExtensionError): Error {
	return new Error(`${error.code}: ${error.message}`);
}

export default createCodexImageExtension();
