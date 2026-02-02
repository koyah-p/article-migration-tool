class MigrationEngine {
    constructor() {
        this.parser = new DOMParser();
    }

    /**
     * Converts a simplified pattern string into a Regular Expression.
     * Robust Version: Handles whitespace differences between pattern and source.
     */
    compilePattern(patternString) {
        // 1. Split by {{variable}}
        // We want to transform the static parts (HTML tags) to be regex-safe AND whitespace-flexible.

        const parts = patternString.split(/({{\w+}})/g);
        let regexStr = '';
        const vars = [];

        parts.forEach(part => {
            // Check if it's a variable reference
            const varMatch = part.match(/^{{(\w+)}}$/);
            if (varMatch) {
                // It's a variable
                vars.push(varMatch[1]);
                // Capture content non-greedy
                regexStr += '([\\s\\S]*?)';
            } else {
                // It's static text
                if (!part) return; // Empty split result

                // Escape regex special chars
                let escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // 1. Flexible Whitespace: Replace meaningful whitespace with \s*
                escaped = escaped.replace(/\s+/g, '\\s*');

                // 2. Flexible Quotes: Replace " or ' with ['"] (match either)
                // note: " and ' are not special regex chars so they weren't escaped by step 1
                escaped = escaped.replace(/["']/g, "['\"]");

                // 3. Flexible Tag Closing: Replace > with \s*/?> to match > or />
                // This helps with <img ...> vs <img ... />
                escaped = escaped.replace(/>/g, "\\s*\\/?>");

                // 4. Flexible Attribute Spacing & Content (Experimental)
                // If there is a space, it might mean "next attribute".
                // We permit extra attributes in between by allowing [^>]*
                // But we must be careful not to break "Tag Name" separation.
                // For now, let's just allow \s+ (which we did in step 1).

                regexStr += escaped;
            }
        });

        return {
            regex: new RegExp(regexStr, 'gi'),
            variables: vars
        };
    }

    /**
     * Renders a target pattern with given data.
     * Applies strict rules: if a variable is empty, try to avoid empty tags?
     * Actually rule is: "If target part has 'title' or 'a tag', but source text is missing, don't add empty tag."
     */
    renderTarget(patternString, data) {
        let result = patternString;

        // simple replace
        for (const [key, value] of Object.entries(data)) {
            // Regex to replace {{key}}
            const varRegex = new RegExp(`{{${key}}}`, 'g');
            result = result.replace(varRegex, value || '');
        }

        // Clean up empty interpolation leftovers
        result = result.replace(/{{\w+}}/g, '');

        // Standardize empty hrefs (handle href="" or href='')
        // If href matches nothing or empty string, we want to strip the A tag.
        // Regex: <a [^>]*href=["']?["']?[^>]*>([\s\S]*?)<\/a>
        // Use a loop to handle nesting or multiple occurrences strictly? 
        // Simple regex approach:
        result = result.replace(/<a\s+(?:[^>]*?\s+)?href=(["'])(?:\s*)\1[^>]*>([\s\S]*?)<\/a>/gi, '$2');
        result = result.replace(/<a\s+(?:[^>]*?\s+)?href=(?:(?!\s|>)[^"'])+[^>]*>([\s\S]*?)<\/a>/gi, '$1'); // no quotes
        // Special case: href is empty attribute <a href ...>
        // Simplest check: if we just produced href="", strip it.
        result = result.replace(/<a\s+[^>]*href=["']["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');

        // Strict Rule: Remove empty tags that might have been created
        // Removed aggressive regex here. 
        // We rely on 'cleanHtml' (DOM based) which occurs after migration and is smarter (preserves semantic spacers).
        // result = result.replace(/<(\w+)[^>]*>\s*<\/\1>/gi, '');

        return result;
    }

    /**
     * Main migration function.
     * @param {string} sourceHtml 
     * @param {Array} sourceParts - definitions from registry
     * @param {Array} targetParts - definitions from registry (must match by name)
     */
    migrate(sourceHtml, sourceParts, targetParts) {
        let currentHtml = sourceHtml;
        let previewHtml = sourceHtml; // Will contain highlights

        // We need to map target parts by name for easy lookup
        const targetMap = {};
        targetParts.forEach(p => targetMap[p.name] = p.pattern);

        const missingMappings = []; // Track missing parts

        // Iterate over source parts and attempt to find valid matches
        // Optimization: Sort source parts by complexity or length? 
        // For now, sequential order.

        // Optimize: Sort source parts by **Pattern Length** (Descending).
        // Larger blocks (containers) should be matched before smaller ones (inner tags).
        // Otherwise, replacing an inner tag might break the outer tag's pattern.
        const sortedSourceParts = [...sourceParts].sort((a, b) => b.pattern.length - a.pattern.length);

        for (const sPart of sortedSourceParts) {
            const tPattern = targetMap[sPart.name];
            if (!tPattern) {
                // Check if this source part IS actually used in the HTML.
                // If it is used but we can't convert it, that's a reportable "Missing Mapping".
                // Use standard compilePattern (STABLE check)
                const { regex } = this.compilePattern(sPart.pattern);
                if (regex.test(currentHtml)) {
                    missingMappings.push({
                        name: sPart.name,
                        pattern: sPart.pattern
                    });
                }
                continue;
            }

            // Check if this part is a "Simple Container" (e.g. <div class="box">{{content}}</div>)
            // If so, we use Balanced Matching to handle nesting correctly.
            const containerInfo = this.analyzeContainer(sPart.pattern);

            if (containerInfo.isContainer) {
                currentHtml = this.migrateBalanced(currentHtml, sPart, tPattern, containerInfo);
            } else {
                // Fallback to Standard Regex Migration
                const { regex, variables } = this.compilePattern(sPart.pattern);

                currentHtml = currentHtml.replace(regex, (match, ...args) => {
                    const extracted = {};
                    for (let i = 0; i < variables.length; i++) {
                        extracted[variables[i]] = args[i] || '';
                    }
                    const newHtml = this.renderTarget(tPattern, extracted);
                    return `<!--__DIFF_START__-->${newHtml}<!--__DIFF_END__-->`;
                });
            }
        }

        // DOM-based Cleanup (Fixes invalid tags, unclosed tags, and removes empties)
        currentHtml = this.cleanHtml(currentHtml);

        // Now we separate Code and Preview
        // Code: Strip markers
        let codeOutput = currentHtml.replace(/<!--__DIFF_START__-->|<!--__DIFF_END__-->/g, '');

        // Fix: Unescape comment closers that might have been mangled to --&gt;
        // Also unescape the start if it was mangled to &lt;!--
        codeOutput = codeOutput.replace(/--&gt;/g, '-->').replace(/&lt;!--/g, '<!--');

        // Preview: We want to show the CODE with highlights, not rendered HTML.
        // 1. Split by markers
        // 2. Escape HTML in the text parts
        // 3. Reassemble with highlight spans

        const parts = currentHtml.split(/(<!--__DIFF_START__-->|<!--__DIFF_END__-->)/g);
        previewHtml = "";

        parts.forEach(part => {
            if (part === '<!--__DIFF_START__-->') {
                previewHtml += '<span class="diff-highlight">';
            } else if (part === '<!--__DIFF_END__-->') {
                previewHtml += '</span>';
            } else {
                // Escape HTML chars
                previewHtml += part
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#039;");
            }
        });

        return { code: codeOutput, preview: previewHtml, missing: missingMappings };
    }

    /**
     * Parses HTML string -> DOM -> String to fix structural errors.
     * Also recursively removes empty elements.
     */
    cleanHtml(htmlString) {
        const div = document.createElement('div');
        div.innerHTML = htmlString;

        this.recursiveRemoveEmpty(div);

        return div.innerHTML;
    }

    recursiveRemoveEmpty(node) {
        // Process children first (bottom-up)
        const children = [...node.children]; // snapshot
        children.forEach(child => this.recursiveRemoveEmpty(child));

        // Check if current node should be removed
        // Condition: Empty innerText, No children (or only empty children), Not a void tag
        const isElement = node.nodeType === 1; // Element
        if (isElement) {
            const tagName = node.tagName.toLowerCase();
            const voidTags = ['img', 'br', 'hr', 'input', 'meta', 'link'];

            // Markers should be preserved (they are Comments usually, but we are using string markers before this?)
            // Wait, our markers are <!--...--> which are Comment Nodes.
            // Comment nodes (nodeType 8) are preserved by default as they have no children.

            if (voidTags.includes(tagName)) return;

            // Allow-list for empty tags (semantic spacers, icons, specific classes)
            // 1. Specific classes to preserve
            if (node.classList.contains('numbering-num')) return;

            // 2. Common "Icon" or "Decoration" tags often empty: span, i, em
            // Also preserve TABLE CELLS (th, td) which are structural even if empty.
            if (['span', 'i', 'em', 'strong', 'b', 'th', 'td'].includes(tagName)) {
                // For span/i etc, we required attributes. For table cells, empty is valid structure.
                if (['th', 'td'].includes(tagName)) return;
                if (node.attributes.length > 0) return;
            }

            // Simple logic: If textContent is empty and no element children (except markers?)
            // Note: node.children is Element Children only.

            if (node.children.length === 0 && node.textContent.trim() === '') {
                // Completely empty
                node.remove();
            } else {
                // Has nodes. Check if they are just whitespace text nodes?
                // Or check if it only contains empty text nodes.
                // If it has comment nodes (markers), we should probably keep it, 
                // because it means a substitution happened here.
            }
        }
    }

    /**
     * Parses a Markdown string used for defining parts.
     * Format:
     * # Part Name
     * ## Pattern
     * <html pattern>
     * 
     * @param {string} mdContent 
     * @returns {Array} Array of part objects {name, pattern}
     */
    parseMarkdownParts(mdContent) {
        const parts = [];
        // Split by line starting with "# "
        // logical sections
        const lines = mdContent.split(/\r?\n/);

        let currentPart = null;
        let mode = null; // 'name', 'pattern_search', 'pattern_content'

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('# ')) {
                // New Part
                if (currentPart && currentPart.name && currentPart.pattern) {
                    currentPart.pattern = currentPart.pattern.trim();
                    parts.push(currentPart);
                }
                currentPart = { name: line.substring(2).trim(), pattern: '' };
                mode = 'pattern_search';
            } else if (line.startsWith('## Pattern')) {
                mode = 'pattern_content';
            } else if (mode === 'pattern_content') {
                // Collect content
                // Skip empty leading lines if pattern is empty so far?
                if (currentPart) {
                    currentPart.pattern += line + '\n';
                }
            }
        }

        // Push last part
        if (currentPart && currentPart.name && currentPart.pattern) {
            currentPart.pattern = currentPart.pattern.trim();
            parts.push(currentPart);
        }

        return parts;
    }

    // --- Balanced Matching Helpers ---

    analyzeContainer(pattern) {
        // Detect pattern: <Tag attrs...> {{var}} </Tag>
        // Allow flexible whitespace
        // Regex to parse PRE-compiled pattern string is hard.
        // Let's rely on the raw string features.
        // It must start with <, end with >.
        // Middle must have exactly one {{variable}}.

        const vars = pattern.match(/{{\w+}}/g);
        if (!vars || vars.length !== 1) return { isContainer: false };

        // Check structure
        // Split by the var
        const pieces = pattern.split(vars[0]);
        if (pieces.length !== 2) return { isContainer: false };

        const [startStr, endStr] = pieces;

        // Check if start matches an opening tag
        // Simple check: Starts with <tagName ... >
        const tagMatch = startStr.match(/^\s*<(\w+)/);
        if (!tagMatch) return { isContainer: false };
        const tagName = tagMatch[1];

        // Check if end matches closing tag
        // </tagName> with whitespace
        const closeRegex = new RegExp(`^\\s*<\\/${tagName}\\s*>\\s*$`, 'i');
        if (!closeRegex.test(endStr)) return { isContainer: false };

        return {
            isContainer: true,
            tagName: tagName,
            startPattern: startStr,
            variable: vars[0].replace(/[{}]/g, '') // "content"
        };
    }

    migrateBalanced(html, sPart, tPattern, info) {
        // 1. Compile Regex for the START part only
        // Reuse compilePattern but for startStr
        // Note: startStr might contain NO variables. compilePattern works for that too.
        const startRes = this.compilePattern(info.startPattern);

        // We use this regex to find CANDIDATE starts
        // But we must strictly find the balanced end.

        const matches = [];
        let match;

        // We need 'global' flag for exec
        const regex = new RegExp(startRes.regex.source, 'gi');

        while ((match = regex.exec(html)) !== null) {
            const startIndex = match.index;
            const contentStartIndex = startIndex + match[0].length;

            // Find balanced closing tag starting from contentStartIndex
            const closeIndex = this.findBalancedCloseIndex(html, contentStartIndex, info.tagName);

            if (closeIndex !== -1) {
                const contentEndIndex = closeIndex;
                const totalEndIndex = html.indexOf('>', closeIndex) + 1; // After </div>

                // Content
                const content = html.substring(contentStartIndex, contentEndIndex);

                matches.push({
                    start: startIndex,
                    end: totalEndIndex,
                    content: content
                });

                // CRITICAL: Advance regex index to avoid finding nested matches of the same type within this match.
                // If we don't do this, we get overlapping matches (Outer & Inner), and the reverse-replacement loop
                // will apply Inner replacement (changing string length) and then Outer replacement using WRONG indices.
                // By skipping to totalEndIndex, we only process top-level matches in this pass.
                regex.lastIndex = totalEndIndex;
            }
        }

        // Replace from LAST to FIRST to avoid index shift
        matches.reverse().forEach(m => {
            // Prepare data
            const data = {};
            data[info.variable] = m.content;

            // Render
            const newSnippet = this.renderTarget(tPattern, data);
            const replacement = `<!--__DIFF_START__-->${newSnippet}<!--__DIFF_END__-->`;

            // Apply replacement
            const before = html.substring(0, m.start);
            const after = html.substring(m.end);
            html = before + replacement + after;
        });

        return html;
    }

    findBalancedCloseIndex(html, fromIndex, tagName) {
        let depth = 1;
        const lowerTag = tagName.toLowerCase();

        // Match <tag... or </tag>
        // Use a combined regex for efficiency (one pass)
        // Group 1: Open Tag (<div...)
        // Group 2: Close Tag (</div>)
        const regex = new RegExp(`(<${lowerTag}[\\s>])|(<\\/${lowerTag}\\s*>)`, 'gi');

        regex.lastIndex = fromIndex;

        let match;
        while ((match = regex.exec(html)) !== null) {
            // match[1] is Open, match[2] is Close
            if (match[1]) {
                depth++;
            } else if (match[2]) {
                depth--;
            }

            if (depth === 0) {
                return match.index; // Start of the closing tag
            }
        }

        return -1; // Not found
    }
}
