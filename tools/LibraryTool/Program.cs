// =============================================================================
// Free Library — C# CLI tool
// Replaces:  scripts/prepare-library.mjs  AND  scripts/copy-site.mjs
//
// Commands:
//   dotnet run --project tools/LibraryTool -- add-books [folder] [--force]
//   dotnet run --project tools/LibraryTool -- copy-site
// =============================================================================

using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// Resolve the repo root.
// This binary lives in  tools/LibraryTool/bin/…  so we go up until we find package.json.
var repoRoot = FindRepoRoot(AppContext.BaseDirectory)
    ?? throw new InvalidOperationException("Could not locate repo root (no package.json found).");
Directory.SetCurrentDirectory(repoRoot);

var cmd = args.FirstOrDefault() ?? "";

switch (cmd)
{
    case "add-books":
        await AddBooksAsync(args.Skip(1).ToArray());
        break;

    case "copy-site":
        CopySite();
        break;

    default:
        Console.WriteLine("""
            Free Library — C# CLI tool
            
            Usage:
              dotnet run --project tools/LibraryTool -- add-books [folder] [--force]
                  Upload every PDF in [folder] (default: ./pdfs) to Vercel Blob,
                  update books.json and api/_catalog.json.
                  Re-running is safe — already-uploaded files are skipped.
                  Pass --force to re-upload everything.
            
              dotnet run --project tools/LibraryTool -- copy-site
                  Copy .publish/wwwroot → public/ and patch the importmap in index.html.
                  Run this after:  dotnet publish src/WikiLibrary -c Release -o .publish
            """);
        break;
}

// =============================================================================
//  add-books
// =============================================================================
static async Task AddBooksAsync(string[] args)
{
    const string BooksJson   = "src/WikiLibrary/wwwroot/data/books.json";
    const string CatalogJson = "api/_catalog.json";
    const int    Concurrency = 4;

    var folder = args.FirstOrDefault(a => !a.StartsWith('-')) ?? "./pdfs";
    var force  = args.Contains("--force");

    // ── 1. Load BLOB_READ_WRITE_TOKEN ────────────────────────────────────────
    var token = GetEnvVar("BLOB_READ_WRITE_TOKEN")
        ?? throw new InvalidOperationException(
            "BLOB_READ_WRITE_TOKEN is missing.\n" +
            "Run:  vercel env pull .env.local\n" +
            "Then re-run this command.");

    // ── 2. Find PDFs ─────────────────────────────────────────────────────────
    if (!Directory.Exists(folder))
        throw new DirectoryNotFoundException($"Folder not found: {folder}");

    var files = Directory
        .EnumerateFiles(folder, "*.pdf", SearchOption.AllDirectories)
        .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
        .ToList();

    Console.WriteLine($"Found {files.Count} PDF(s) in {folder}");
    if (files.Count == 0) return;

    // ── 3. Load existing books.json ──────────────────────────────────────────
    var existing = new List<JsonObject>();
    if (File.Exists(BooksJson))
    {
        var raw = await File.ReadAllTextAsync(BooksJson);
        existing = JsonSerializer.Deserialize<List<JsonObject>>(raw, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? [];
    }

    var byPath = existing.ToDictionary(
        b => b["blobPathname"]?.GetValue<string>() ?? "",
        b => b,
        StringComparer.Ordinal);

    int nextId = existing.Count > 0
        ? existing.Max(b => b["id"]?.GetValue<int>() ?? 0) + 1
        : 1;

    // ── 4. Assign blob pathnames & IDs (single-threaded, deterministic) ──────
    var used = new HashSet<string>(StringComparer.Ordinal);
    var jobs = files.Select(file =>
    {
        var slug      = Slugify(TitleFromFile(file));
        var candidate = slug;
        var n         = 2;
        while (used.Contains(candidate)) candidate = $"{slug}-{n++}";
        used.Add(candidate);

        var pathname  = $"books/{candidate}.pdf";
        var existingEntry = byPath.GetValueOrDefault(pathname);
        var id        = existingEntry?["id"]?.GetValue<int>() ?? nextId++;

        return (file, pathname, id, existing: existingEntry);
    }).ToList();

    // ── 5. Upload with bounded concurrency ───────────────────────────────────
    using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", token);
    http.DefaultRequestHeaders.TryAddWithoutValidation("x-api-version",        "7");
    http.DefaultRequestHeaders.TryAddWithoutValidation("x-add-random-suffix",  "0");
    http.DefaultRequestHeaders.TryAddWithoutValidation("x-allow-overwrite",    "1");
    http.DefaultRequestHeaders.TryAddWithoutValidation("x-content-type",       "application/pdf");

    var books     = new List<JsonObject>(jobs.Count);
    var booksLock = new object();
    int done      = 0;
    var sem       = new SemaphoreSlim(Concurrency, Concurrency);

    var tasks = jobs.Select(async job =>
    {
        var (file, pathname, id, existingEntry) = job;

        await sem.WaitAsync();
        try
        {
            if (existingEntry is null || force)
            {
                // Encode path segments but keep forward slashes
                var encodedPath = string.Join("/",
                    pathname.Split('/').Select(Uri.EscapeDataString));
                var url = $"https://blob.vercel-storage.com/{encodedPath}";

                await using var fs = File.OpenRead(file);
                using var content  = new StreamContent(fs);
                content.Headers.ContentType =
                    new MediaTypeHeaderValue("application/pdf");

                using var request = new HttpRequestMessage(HttpMethod.Put, url)
                    { Content = content };

                var response = await http.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync();
                    throw new HttpRequestException(
                        $"Upload failed for {pathname}: {response.StatusCode}\n{body}");
                }
            }

            var fileInfo = new FileInfo(file);
            var book = new JsonObject
            {
                ["id"]          = id,
                ["title"]       = existingEntry?["title"]?.GetValue<string>()       ?? TitleFromFile(file),
                ["author"]      = existingEntry?["author"]?.GetValue<string>()      ?? "Unknown author",
                ["description"] = existingEntry?["description"]?.GetValue<string>() ?? "No description yet.",
                ["category"]    = existingEntry?["category"]?.GetValue<string>()    ?? "Uncategorized",
                ["year"]        = existingEntry?["year"]?.GetValue<int>()           ?? 0,
                ["language"]    = existingEntry?["language"]?.GetValue<string>()    ?? "English",
                ["pages"]       = existingEntry?["pages"]?.GetValue<int>()          ?? 0,
                ["fileSize"]    = fileInfo.Length,
                ["blobPathname"]= pathname,
            };

            lock (booksLock) books.Add(book);

            var n = Interlocked.Increment(ref done);
            var tag = existingEntry is null || force ? "uploaded" : "skipped ";
            Console.WriteLine($"  [{n,3}/{jobs.Count}] {tag}  {pathname}");
        }
        finally { sem.Release(); }
    });

    await Task.WhenAll(tasks);

    // ── 6. Write books.json and api/_catalog.json ────────────────────────────
    var sorted = books.OrderBy(b => b["id"]?.GetValue<int>() ?? 0).ToList();
    var writeOptions = new JsonSerializerOptions { WriteIndented = true };

    Directory.CreateDirectory(Path.GetDirectoryName(BooksJson)!);
    await File.WriteAllTextAsync(BooksJson,
        JsonSerializer.Serialize(sorted, writeOptions));

    var catalog = new JsonObject();
    foreach (var b in sorted)
        catalog[b["id"]!.GetValue<int>().ToString()] =
            b["blobPathname"]!.GetValue<string>();
    await File.WriteAllTextAsync(CatalogJson,
        JsonSerializer.Serialize(catalog, writeOptions));

    Console.WriteLine();
    Console.WriteLine($"✓ Wrote {sorted.Count} books to {BooksJson}");
    Console.WriteLine($"✓ Wrote catalog to {CatalogJson}");
    Console.WriteLine();
    Console.WriteLine("Next steps:");
    Console.WriteLine("  1. Edit author / category / description in books.json");
    Console.WriteLine("  2. dotnet publish src/WikiLibrary -c Release -o .publish");
    Console.WriteLine("  3. dotnet run --project tools/LibraryTool -- copy-site");
    Console.WriteLine("  4. vercel build --prod && vercel deploy --prebuilt --prod");
}

// =============================================================================
//  copy-site  (replaces scripts/copy-site.mjs)
// =============================================================================
static void CopySite()
{
    const string PublishWwwRoot = ".publish/wwwroot";
    const string PublicDir      = "public";

    if (!Directory.Exists(PublishWwwRoot))
        throw new DirectoryNotFoundException(
            $"Publish output not found at {PublishWwwRoot}.\n" +
            "Run first:  dotnet publish src/WikiLibrary -c Release -o .publish");

    Console.Write($"Copying {PublishWwwRoot} → {PublicDir}/ ... ");

    if (Directory.Exists(PublicDir))
        Directory.Delete(PublicDir, recursive: true);

    CopyDirectory(PublishWwwRoot, PublicDir);
    Console.WriteLine("done.");

    // Patch importmap in public/index.html
    var frameworkDir  = Path.Combine(PublicDir, "_framework");
    var allFramework  = Directory.EnumerateFiles(frameworkDir)
                                 .Select(Path.GetFileName)
                                 .OfType<string>()
                                 .ToArray();

    var runtimeFile   = allFramework.FirstOrDefault(
        f => Regex.IsMatch(f, @"^dotnet\.runtime\..+\.js$"));
    var nativeFile    = allFramework.FirstOrDefault(
        f => Regex.IsMatch(f, @"^dotnet\.native\..+\.js$"));

    if (runtimeFile is not null && nativeFile is not null)
    {
        var importmap = $@"{{""imports"":{{""./dotnet.js"":""./_framework/dotnet.js"",""./dotnet.runtime.js"":""./_framework/{runtimeFile}"",""./dotnet.native.js"":""./_framework/{nativeFile}""}}}}";

        var indexPath = Path.Combine(PublicDir, "index.html");
        var html = File.ReadAllText(indexPath);

        html = Regex.Replace(
            html,
            @"<script type=""importmap""></script>",
            $"""<script type="importmap">{importmap}</script>""");

        // Also fix the blazor.webassembly.[fingerprint].js reference if present
        html = Regex.Replace(
            html,
            @"_framework/blazor\.webassembly#\[\.{fingerprint}\]\.js",
            "_framework/blazor.webassembly.js");

        File.WriteAllText(indexPath, html);
        Console.WriteLine($"✓ Patched importmap (runtime={runtimeFile}, native={nativeFile})");
    }
    else
    {
        Console.Error.WriteLine("⚠  Could not find fingerprinted dotnet runtime/native JS files.");
    }

    Console.WriteLine($"✓ public/ ready for deployment.");
}

// =============================================================================
//  Helpers
// =============================================================================
static void CopyDirectory(string src, string dst)
{
    Directory.CreateDirectory(dst);
    foreach (var file in Directory.EnumerateFiles(src))
        File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), overwrite: true);
    foreach (var dir in Directory.EnumerateDirectories(src))
        CopyDirectory(dir, Path.Combine(dst, Path.GetFileName(dir)));
}

static string TitleFromFile(string file) =>
    Regex.Replace(
        Path.GetFileNameWithoutExtension(file),
        @"[_\-\.]+", " ")
    .Trim();

static string Slugify(string text)
{
    // Normalise, strip non-ASCII, lowercase, collapse whitespace → dashes
    var s = text
        .Normalize(System.Text.NormalizationForm.FormKD);
    s = Regex.Replace(s, @"[^\w\s-]", "").Trim().ToLowerInvariant();
    s = Regex.Replace(s, @"[\s_]+", "-");
    return string.IsNullOrEmpty(s) ? "book" : s;
}

static string? GetEnvVar(string name)
{
    // 1. Real environment variable (e.g. CI / shell export)
    var val = Environment.GetEnvironmentVariable(name);
    if (!string.IsNullOrWhiteSpace(val)) return val.Trim();

    // 2. .env.local file (key=value, optional quotes)
    if (!File.Exists(".env.local")) return null;

    foreach (var line in File.ReadLines(".env.local"))
    {
        if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith('#'))
            continue;
        var eq = line.IndexOf('=');
        if (eq < 0) continue;
        var key = line[..eq].Trim();
        if (!key.Equals(name, StringComparison.Ordinal)) continue;
        return line[(eq + 1)..].Trim().Trim('"');
    }
    return null;
}

static string? FindRepoRoot(string start)
{
    var dir = new DirectoryInfo(start);
    while (dir is not null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "package.json")))
            return dir.FullName;
        dir = dir.Parent;
    }
    return null;
}
