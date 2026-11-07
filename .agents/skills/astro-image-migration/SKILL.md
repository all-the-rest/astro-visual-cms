---
name: astro-image-migration
description: Plan and validate a migration from Astro image imports to a slug-based image resolver without changing existing image files or content before review. Use only after the target resolver and wrapper have been implemented and their contract documented.
---

# Astro image migration — preliminary procedure

This is a migration planning and verification skill, not an implementation of an
image resolver. Do not invent an API: first read the consuming project's rules
and the library's current, tested resolver and component documentation. If that
contract does not exist, stop after inventory and report the blocker.

## Safety and inventory

1. Inspect the worktree and leave unrelated changes intact. Respect the project's
   image-review and metadata rules. Never delete, rename, upload or overwrite
   image files or generated metadata without the required approval.
2. Inventory direct, dynamic and glob image imports, including imports emitted by
   Vite plugins and virtual modules; image references in MDX, collections and
   components; current slug mappings; metadata and responsive/EXIF behavior.
   Distinguish development from production paths.
3. List unsupported dynamic expressions, collisions, missing slugs, inaccessible
   files, external images and usages that require manual decisions. Do not guess
   image identities or rewrite imports based only on a matching filename.
4. Produce a dry-run migration plan with the proposed source diffs, expected
   behavior and rollback. Obtain the approval required by the consuming project
   before changing image content, naming, review artifacts or production files.

## Migration and verification

5. Apply only mappings whose source and destination are unambiguous. Use the
   documented wrapper and slug-to-metadata API; preserve alt text, dimensions,
   EXIF, responsive behavior, links, layout and gallery ordering. Leave unsupported
   references unchanged and report them rather than coercing them.
6. Check the entire project and generated Vite modules for remaining image
   imports, not just handwritten `import` statements. Run the consuming project's
   build, type checks, image/link checks and relevant tests. Exercise local dev,
   production output, viewport variants and representative galleries in a real
   browser; verify image requests, dimensions, alt text and metadata.
7. Report exactly what changed, which references remain, tests performed and
   whether optimization and CDN behavior were actually verified. A public URL
   passed to Astro `Image` does not by itself prove image optimization. Do not
   deploy or remove the old pipeline without explicit authorization.
