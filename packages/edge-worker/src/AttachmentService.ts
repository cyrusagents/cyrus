import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
	IIssueTrackerService,
	ILogger,
	Issue,
	RepositoryConfig,
} from "cyrus-core";
import { fileTypeFromBuffer } from "file-type";

export class AttachmentService {
	private logger: ILogger;
	private cyrusHome: string;

	constructor(logger: ILogger, cyrusHome: string) {
		this.logger = logger;
		this.cyrusHome = cyrusHome;
	}

	extractAttachmentUrls(text: string): string[] {
		if (!text) return [];

		// Match URLs that start with https://uploads.linear.app
		// Exclude brackets and parentheses to avoid capturing malformed markdown link syntax
		const regex = /https:\/\/uploads\.linear\.app\/[a-zA-Z0-9/_.-]+/gi;
		const matches = text.match(regex) || [];

		// Remove duplicates
		return [...new Set(matches)];
	}

	/**
	 * Download attachments from Linear issue
	 * @param issue Linear issue object from webhook data
	 * @param repository Repository configuration
	 * @param workspacePath Path to workspace directory
	 * @param issueTracker Optional issue tracker service for fetching comments and native attachments
	 */
	async downloadIssueAttachments(
		issue: Issue,
		repository: RepositoryConfig,
		workspacePath: string,
		issueTracker?: IIssueTrackerService,
	): Promise<{ manifest: string; attachmentsDir: string | null }> {
		// Create attachments directory in home directory
		const workspaceFolderName = basename(workspacePath);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);

		try {
			const attachmentMap: Record<string, string> = {};
			const imageMap: Record<string, string> = {};
			let attachmentCount = 0;
			let imageCount = 0;
			let skippedCount = 0;
			let failedCount = 0;
			const maxAttachments = 20;

			// Ensure directory exists
			await mkdir(attachmentsDir, { recursive: true });

			// Extract URLs from issue description
			const descriptionUrls = this.extractAttachmentUrls(
				issue.description || "",
			);

			// Extract URLs from comments if available
			const commentUrls: string[] = [];

			// Fetch native Linear attachments (e.g., Sentry links)
			const nativeAttachments: Array<{ title: string; url: string }> = [];
			if (issueTracker && issue.id) {
				try {
					// Fetch native attachments using Linear SDK
					this.logger.debug(
						`Fetching native attachments for issue ${issue.identifier}`,
					);
					const attachments = await issue.attachments();
					if (attachments?.nodes) {
						for (const attachment of attachments.nodes) {
							nativeAttachments.push({
								title: attachment.title || "Untitled attachment",
								url: attachment.url,
							});
						}
						this.logger.debug(
							`Found ${nativeAttachments.length} native attachments`,
						);
					}
				} catch (error) {
					this.logger.error("Failed to fetch native attachments:", error);
				}

				try {
					const comments = await issueTracker.fetchComments(issue.id);
					const commentNodes = comments.nodes;
					for (const comment of commentNodes) {
						const urls = this.extractAttachmentUrls(comment.body);
						commentUrls.push(...urls);
					}
				} catch (error) {
					this.logger.error("Failed to fetch comments for attachments:", error);
				}
			}

			// Combine and deduplicate all URLs
			const allUrls = [...new Set([...descriptionUrls, ...commentUrls])];

			this.logger.debug(
				`Found ${allUrls.length} unique attachment URLs in issue ${issue.identifier}`,
			);

			if (allUrls.length > maxAttachments) {
				this.logger.warn(
					`Warning: Found ${allUrls.length} attachments but limiting to ${maxAttachments}. Skipping ${allUrls.length - maxAttachments} attachments.`,
				);
			}

			// Download attachments up to the limit
			for (const url of allUrls) {
				if (attachmentCount >= maxAttachments) {
					skippedCount++;
					continue;
				}

				// Generate a temporary filename
				const tempFilename = `attachment_${attachmentCount + 1}.tmp`;
				const tempPath = join(attachmentsDir, tempFilename);

				const result = await this.downloadAttachment(
					url,
					tempPath,
					repository.linearToken,
				);

				if (result.success) {
					// Determine the final filename based on type
					let finalFilename: string;
					if (result.isImage) {
						imageCount++;
						finalFilename = `image_${imageCount}${result.fileType || ".png"}`;
					} else {
						finalFilename = `attachment_${attachmentCount + 1}${result.fileType || ""}`;
					}

					const finalPath = join(attachmentsDir, finalFilename);

					// Rename the file to include the correct extension
					await rename(tempPath, finalPath);

					// Store in appropriate map
					if (result.isImage) {
						imageMap[url] = finalPath;
					} else {
						attachmentMap[url] = finalPath;
					}
					attachmentCount++;
				} else {
					failedCount++;
					this.logger.warn(`Failed to download attachment: ${url}`);
				}
			}

			// Generate attachment manifest
			const manifest = this.generateAttachmentManifest({
				attachmentMap,
				imageMap,
				totalFound: allUrls.length,
				downloaded: attachmentCount,
				imagesDownloaded: imageCount,
				skipped: skippedCount,
				failed: failedCount,
				nativeAttachments,
			});

			// Always return the attachments directory path (it's pre-created)
			return {
				manifest,
				attachmentsDir: attachmentsDir,
			};
		} catch (error) {
			this.logger.error("Error downloading attachments:", error);
			// Still return the attachments directory even on error
			return { manifest: "", attachmentsDir: attachmentsDir };
		}
	}

	/**
	 * Download a single attachment from Linear
	 */
	async downloadAttachment(
		attachmentUrl: string,
		destinationPath: string,
		linearToken: string,
	): Promise<{ success: boolean; fileType?: string; isImage?: boolean }> {
		try {
			this.logger.debug(`Downloading attachment from: ${attachmentUrl}`);

			const response = await fetch(attachmentUrl, {
				headers: {
					Authorization: `Bearer ${linearToken}`,
				},
			});

			if (!response.ok) {
				this.logger.error(
					`Attachment download failed: ${response.status} ${response.statusText}`,
				);
				return { success: false };
			}

			const buffer = Buffer.from(await response.arrayBuffer());

			// Detect the file type from the buffer
			const fileType = await fileTypeFromBuffer(buffer);
			let detectedExtension: string | undefined;
			let isImage = false;

			if (fileType) {
				detectedExtension = `.${fileType.ext}`;
				isImage = fileType.mime.startsWith("image/");
				this.logger.debug(
					`Detected file type: ${fileType.mime} (${fileType.ext}), is image: ${isImage}`,
				);
			} else {
				// Try to get extension from URL
				const urlPath = new URL(attachmentUrl).pathname;
				const urlExt = extname(urlPath);
				if (urlExt) {
					detectedExtension = urlExt;
					this.logger.debug(`Using extension from URL: ${detectedExtension}`);
				}
			}

			// Write the attachment to disk
			await writeFile(destinationPath, buffer);

			this.logger.debug(
				`Successfully downloaded attachment to: ${destinationPath}`,
			);
			return { success: true, fileType: detectedExtension, isImage };
		} catch (error) {
			this.logger.error(`Error downloading attachment:`, error);
			return { success: false };
		}
	}

	/**
	 * Download attachments from a specific comment
	 * @param commentBody The body text of the comment
	 * @param attachmentsDir Directory where attachments should be saved
	 * @param linearToken Linear API token
	 * @param existingAttachmentCount Current number of attachments already downloaded
	 */
	async downloadCommentAttachments(
		commentBody: string,
		attachmentsDir: string,
		linearToken: string,
		existingAttachmentCount: number,
	): Promise<{
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}> {
		const newAttachmentMap: Record<string, string> = {};
		const newImageMap: Record<string, string> = {};
		let newAttachmentCount = 0;
		let newImageCount = 0;
		let failedCount = 0;
		const maxAttachments = 20;

		// Extract URLs from the comment
		const urls = this.extractAttachmentUrls(commentBody);

		if (urls.length === 0) {
			return {
				newAttachmentMap,
				newImageMap,
				totalNewAttachments: 0,
				failedCount: 0,
			};
		}

		this.logger.debug(`Found ${urls.length} attachment URLs in new comment`);

		// Download new attachments
		for (const url of urls) {
			// Skip if we've already reached the total attachment limit
			if (existingAttachmentCount + newAttachmentCount >= maxAttachments) {
				this.logger.warn(
					`Skipping attachment due to ${maxAttachments} total attachment limit`,
				);
				break;
			}

			// Generate filename based on total attachment count
			const attachmentNumber = existingAttachmentCount + newAttachmentCount + 1;
			const tempFilename = `attachment_${attachmentNumber}.tmp`;
			const tempPath = join(attachmentsDir, tempFilename);

			const result = await this.downloadAttachment(url, tempPath, linearToken);

			if (result.success) {
				// Determine the final filename based on type
				let finalFilename: string;
				if (result.isImage) {
					newImageCount++;
					// Count existing images to get correct numbering
					const existingImageCount =
						await this.countExistingImages(attachmentsDir);
					finalFilename = `image_${existingImageCount + newImageCount}${result.fileType || ".png"}`;
				} else {
					finalFilename = `attachment_${attachmentNumber}${result.fileType || ""}`;
				}

				const finalPath = join(attachmentsDir, finalFilename);

				// Rename the file to include the correct extension
				await rename(tempPath, finalPath);

				// Store in appropriate map
				if (result.isImage) {
					newImageMap[url] = finalPath;
				} else {
					newAttachmentMap[url] = finalPath;
				}
				newAttachmentCount++;
			} else {
				failedCount++;
				this.logger.warn(`Failed to download attachment: ${url}`);
			}
		}

		return {
			newAttachmentMap,
			newImageMap,
			totalNewAttachments: newAttachmentCount,
			failedCount,
		};
	}

	/**
	 * Count existing images in the attachments directory
	 */
	async countExistingImages(attachmentsDir: string): Promise<number> {
		try {
			const files = await readdir(attachmentsDir);
			return files.filter((file) => file.startsWith("image_")).length;
		} catch {
			return 0;
		}
	}

	/**
	 * Generate attachment manifest for new comment attachments
	 */
	generateNewAttachmentManifest(result: {
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}): string {
		const { newAttachmentMap, newImageMap, totalNewAttachments, failedCount } =
			result;

		if (totalNewAttachments === 0) {
			return "";
		}

		let manifest = "\n## New Attachments from Comment\n\n";

		manifest += `Downloaded ${totalNewAttachments} new attachment${totalNewAttachments > 1 ? "s" : ""}`;
		if (failedCount > 0) {
			manifest += ` (${failedCount} failed)`;
		}
		manifest += ".\n\n";

		// List new images
		if (Object.keys(newImageMap).length > 0) {
			manifest += "### New Images\n";
			Object.entries(newImageMap).forEach(([url, localPath], index) => {
				const filename = basename(localPath);
				manifest += `${index + 1}. ${filename} - Original URL: ${url}\n`;
				manifest += `   Local path: ${localPath}\n\n`;
			});
			manifest += "You can use the Read tool to view these images.\n\n";
		}

		// List new other attachments
		if (Object.keys(newAttachmentMap).length > 0) {
			manifest += "### New Attachments\n";
			Object.entries(newAttachmentMap).forEach(([url, localPath], index) => {
				const filename = basename(localPath);
				manifest += `${index + 1}. ${filename} - Original URL: ${url}\n`;
				manifest += `   Local path: ${localPath}\n\n`;
			});
			manifest += "You can use the Read tool to view these files.\n\n";
		}

		return manifest;
	}

	/**
	 * Generate a markdown section describing downloaded attachments
	 */
	generateAttachmentManifest(downloadResult: {
		attachmentMap: Record<string, string>;
		imageMap: Record<string, string>;
		totalFound: number;
		downloaded: number;
		imagesDownloaded: number;
		skipped: number;
		failed: number;
		nativeAttachments?: Array<{ title: string; url: string }>;
	}): string {
		const {
			attachmentMap,
			imageMap,
			totalFound,
			downloaded,
			imagesDownloaded,
			skipped,
			failed,
			nativeAttachments = [],
		} = downloadResult;

		let manifest = "\n## Downloaded Attachments\n\n";

		// Add native Linear attachments section if available
		if (nativeAttachments.length > 0) {
			manifest += "### Linear Issue Links\n";
			nativeAttachments.forEach((attachment, index) => {
				manifest += `${index + 1}. ${attachment.title}\n`;
				manifest += `   URL: ${attachment.url}\n\n`;
			});
		}

		if (totalFound === 0 && nativeAttachments.length === 0) {
			manifest += "No attachments were found in this issue.\n\n";
			manifest +=
				"The attachments directory `~/.cyrus/<workspace>/attachments` has been created and is available for any future attachments that may be added to this issue.\n";
			return manifest;
		}

		manifest += `Found ${totalFound} attachments. Downloaded ${downloaded}`;
		if (imagesDownloaded > 0) {
			manifest += ` (including ${imagesDownloaded} images)`;
		}
		if (skipped > 0) {
			manifest += `, skipped ${skipped} due to ${downloaded} attachment limit`;
		}
		if (failed > 0) {
			manifest += `, failed to download ${failed}`;
		}
		manifest += ".\n\n";

		if (failed > 0) {
			manifest +=
				"**Note**: Some attachments failed to download. This may be due to authentication issues or the files being unavailable. The agent will continue processing the issue with the available information.\n\n";
		}

		manifest +=
			"Attachments have been downloaded to the `~/.cyrus/<workspace>/attachments` directory:\n\n";

		// List images first
		if (Object.keys(imageMap).length > 0) {
			manifest += "### Images\n";
			Object.entries(imageMap).forEach(([url, localPath], index) => {
				const filename = basename(localPath);
				manifest += `${index + 1}. ${filename} - Original URL: ${url}\n`;
				manifest += `   Local path: ${localPath}\n\n`;
			});
			manifest += "You can use the Read tool to view these images.\n\n";
		}

		// List other attachments
		if (Object.keys(attachmentMap).length > 0) {
			manifest += "### Other Attachments\n";
			Object.entries(attachmentMap).forEach(([url, localPath], index) => {
				const filename = basename(localPath);
				manifest += `${index + 1}. ${filename} - Original URL: ${url}\n`;
				manifest += `   Local path: ${localPath}\n\n`;
			});
			manifest += "You can use the Read tool to view these files.\n\n";
		}

		return manifest;
	}
}
