using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

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
            Free Library - C# CLI tool
            
            Usage:
              dotnet run --project tools/LibraryTool -- add-books [folder] [--force]
                  Upload every PDF in [folder] (default: ./pdfs) to Vercel Blob,
                  update books.json and api/_catalog.json.
                  Re-running is safe: already-uploaded files are skipped.
                  Pass --force to re-upload everything.
            
              dotnet run --project tools/LibraryTool -- copy-site
                  Copy .publish/wwwroot -> public/ and patch the importmap in index.html.
                  Run this after:  dotnet publish src/WikiLibrary -c Release -o .publish
            """);
        break;
}

static async Task AddBooksAsync(string[] args)
{
    const string BooksJson   = "src/WikiLibrary/wwwroot/data/books.json";
    const string CatalogJson = "api/_catalog.json";
    const int    Concurrency = 1;
    const string PublicBlobBase = "https://awewxdgwtlwxy5wf.public.blob.vercel-storage.com";

    var folder = args.FirstOrDefault(a => !a.StartsWith('-')) ?? "./pdfs";
    var force  = args.Contains("--force");

    if (!Directory.Exists(folder))
        throw new DirectoryNotFoundException($"Folder not found: {folder}");

    var files = Directory
        .EnumerateFiles(folder, "*.pdf", SearchOption.AllDirectories)
        .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
        .ToList();

    Console.WriteLine($"Found {files.Count} PDF(s) in {folder}");
    if (files.Count == 0) return;

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

    var used = new HashSet<string>(StringComparer.Ordinal);
    var jobs = files.Select(file =>
    {
        var slug      = SlugifyFilename(file);
        var candidate = slug;
        var n         = 2;
        while (used.Contains(candidate)) candidate = $"{slug}-{n++}";
        used.Add(candidate);

        var pathname  = $"books/{candidate}.pdf";
        var existingEntry = byPath.GetValueOrDefault(pathname);
        var id        = existingEntry?["id"]?.GetValue<int>() ?? nextId++;

        return (file, pathname, id, existing: existingEntry);
    }).ToList();

    var token = GetEnvVar("BLOB_READ_WRITE_TOKEN");
    var needsUpload = jobs.Any(j => j.existing is null || force);
    if (needsUpload && string.IsNullOrWhiteSpace(token))
    {
        throw new InvalidOperationException(
            "BLOB_READ_WRITE_TOKEN is missing in environment.\n" +
            "New PDF(s) need to be uploaded to Vercel Blob.\n" +
            "Please add BLOB_READ_WRITE_TOKEN to your GitHub repository secrets:\n" +
            "https://github.com/AustinAviv/ebook-library/settings/secrets/actions");
    }

    using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
    if (!string.IsNullOrWhiteSpace(token))
    {
        http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);
        http.DefaultRequestHeaders.TryAddWithoutValidation("x-api-version",        "7");
        http.DefaultRequestHeaders.TryAddWithoutValidation("x-vercel-blob-access",  "public");
        http.DefaultRequestHeaders.TryAddWithoutValidation("x-add-random-suffix",  "0");
        http.DefaultRequestHeaders.TryAddWithoutValidation("x-allow-overwrite",    "1");
        http.DefaultRequestHeaders.TryAddWithoutValidation("x-content-type",       "application/pdf");
    }

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
            string? downloadUrl = null;
            string? publicUrl   = null;

            var encodedPath = string.Join("/",
                pathname.Split('/').Select(Uri.EscapeDataString));
            var publicCheckUrl = $"{PublicBlobBase}/{encodedPath}";

            bool alreadyInPublic = false;
            if (!force)
            {
                try
                {
                    using var headReq = new HttpRequestMessage(HttpMethod.Head, publicCheckUrl);
                    using var headRes = await http.SendAsync(headReq);
                    if (headRes.IsSuccessStatusCode)
                    {
                        alreadyInPublic = true;
                        publicUrl   = publicCheckUrl;
                        downloadUrl = $"{publicCheckUrl}?download=1";
                    }
                }
                catch { }
            }

            if (!alreadyInPublic)
            {
                const int maxRetries = 3;
                for (int attempt = 1; attempt <= maxRetries; attempt++)
                {
                    try
                    {
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

                        var resBody = await response.Content.ReadAsStringAsync();
                        try
                        {
                            var jsonRes = JsonNode.Parse(resBody);
                            publicUrl   = jsonRes?["url"]?.GetValue<string>();
                            downloadUrl = jsonRes?["downloadUrl"]?.GetValue<string>();
                        }
                        catch { }

                        publicUrl   ??= publicCheckUrl;
                        downloadUrl ??= $"{publicCheckUrl}?download=1";
                        break;
                    }
                    catch (Exception ex) when (attempt < maxRetries)
                    {
                        Console.WriteLine($"  [retry {attempt}/{maxRetries}] {pathname}: {ex.Message}");
                        await Task.Delay(TimeSpan.FromSeconds(attempt * 2));
                    }
                }
            }

            var fileInfo = new FileInfo(file);
            var title = existingEntry?["title"]?.GetValue<string>() ?? TitleFromFile(file);

            var book = new JsonObject
            {
                ["id"]          = id,
                ["title"]       = title,
                ["fileSize"]    = fileInfo.Length,
                ["blobPathname"]= pathname,
            };

            if (!string.IsNullOrWhiteSpace(downloadUrl))
                book["downloadUrl"] = downloadUrl;
            if (!string.IsNullOrWhiteSpace(publicUrl))
                book["url"] = publicUrl;

            var existingAuthor = existingEntry?["author"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(existingAuthor) && !existingAuthor.Equals("Unknown author", StringComparison.OrdinalIgnoreCase))
                book["author"] = existingAuthor;

            var existingCat = existingEntry?["category"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(existingCat) && !existingCat.Equals("Uncategorized", StringComparison.OrdinalIgnoreCase))
                book["category"] = existingCat;

            var existingDesc = existingEntry?["description"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(existingDesc) && !existingDesc.Equals("No description yet.", StringComparison.OrdinalIgnoreCase))
                book["description"] = existingDesc;

            lock (booksLock) books.Add(book);

            var n = Interlocked.Increment(ref done);
            var tag = existingEntry is null || force ? "uploaded" : "skipped ";
            Console.WriteLine($"  [{n,3}/{jobs.Count}] {tag}  {pathname}");
        }
        finally { sem.Release(); }
    });

    await Task.WhenAll(tasks);

    var sorted = books.OrderBy(b => b["id"]?.GetValue<int>() ?? 0).ToList();
    var writeOptions = new JsonSerializerOptions { WriteIndented = true };

    Directory.CreateDirectory(Path.GetDirectoryName(BooksJson)!);
    await File.WriteAllTextAsync(BooksJson,
        JsonSerializer.Serialize(sorted, writeOptions));

    var catalog = new JsonObject();
    foreach (var b in sorted)
    {
        var idStr = b["id"]!.GetValue<int>().ToString();
        var dl = b["downloadUrl"]?.GetValue<string>() ?? b["url"]?.GetValue<string>();
        catalog[idStr] = !string.IsNullOrWhiteSpace(dl) ? dl : b["blobPathname"]!.GetValue<string>();
    }
    await File.WriteAllTextAsync(CatalogJson,
        JsonSerializer.Serialize(catalog, writeOptions));

    Console.WriteLine();
    Console.WriteLine($"[OK] Wrote {sorted.Count} books to {BooksJson}");
    Console.WriteLine($"[OK] Wrote catalog to {CatalogJson}");
    Console.WriteLine();
    Console.WriteLine("Next steps:");
    Console.WriteLine("  1. Edit author / category / description in books.json");
    Console.WriteLine("  2. dotnet publish src/WikiLibrary -c Release -o .publish");
    Console.WriteLine("  3. dotnet run --project tools/LibraryTool -- copy-site");
    Console.WriteLine("  4. vercel build --prod && vercel deploy --prebuilt --prod");
}

static void CopySite()
{
    const string PublishWwwRoot = ".publish/wwwroot";
    const string PublicDir      = "public";

    if (!Directory.Exists(PublishWwwRoot))
        throw new DirectoryNotFoundException(
            $"Publish output not found at {PublishWwwRoot}.\n" +
            "Run first:  dotnet publish src/WikiLibrary -c Release -o .publish");

    Console.Write($"Copying {PublishWwwRoot} -> {PublicDir}/ ... ");

    if (Directory.Exists(PublicDir))
        Directory.Delete(PublicDir, recursive: true);

    CopyDirectory(PublishWwwRoot, PublicDir);
    Console.WriteLine("done.");

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

        html = Regex.Replace(
            html,
            @"_framework/blazor\.webassembly#\[\.{fingerprint}\]\.js",
            "_framework/blazor.webassembly.js");

        File.WriteAllText(indexPath, html);
        Console.WriteLine($"[OK] Patched importmap (runtime={runtimeFile}, native={nativeFile})");
    }
    else
    {
        Console.Error.WriteLine("[WARN] Could not find fingerprinted dotnet runtime/native JS files.");
    }

    Console.WriteLine("[OK] public/ ready for deployment.");
}

static void CopyDirectory(string src, string dst)
{
    Directory.CreateDirectory(dst);
    foreach (var file in Directory.EnumerateFiles(src))
        File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), overwrite: true);
    foreach (var dir in Directory.EnumerateDirectories(src))
        CopyDirectory(dir, Path.Combine(dst, Path.GetFileName(dir)));
}

static string TitleFromFile(string file)
{
    var name = Path.GetFileNameWithoutExtension(file);

    name = Regex.Replace(name, @"^(dokumen\.pub_|libgen\.[a-z]+_|z-lib\.org_|\[.*?\]|\(.*?\))\s*", "", RegexOptions.IgnoreCase);
    name = Regex.Replace(name, @"[-_\.]+(110|nbsp|ed)\b", "", RegexOptions.IgnoreCase);
    name = Regex.Replace(name, @"[_\-\.]+", " ");
    name = Regex.Replace(name, @"\s+", " ").Trim();

    if (name.Equals("thinkpython2", StringComparison.OrdinalIgnoreCase))
        return "Think Python (2nd Edition)";

    if (name.All(c => !char.IsLetter(c) || char.IsLower(c)))
        name = System.Globalization.CultureInfo.CurrentCulture.TextInfo.ToTitleCase(name);

    return string.IsNullOrWhiteSpace(name) ? Path.GetFileNameWithoutExtension(file) : name;
}

static string SlugifyFilename(string file)
{
    var raw = Regex.Replace(Path.GetFileNameWithoutExtension(file), @"[_\-\.]+", " ").Trim();
    return Slugify(raw);
}

static string Slugify(string text)
{
    var s = text
        .Normalize(System.Text.NormalizationForm.FormKD);
    s = Regex.Replace(s, @"[^\w\s-]", "").Trim().ToLowerInvariant();
    s = Regex.Replace(s, @"[\s_]+", "-");
    return string.IsNullOrEmpty(s) ? "book" : s;
}

static string? GetEnvVar(string name)
{
    var val = Environment.GetEnvironmentVariable(name);
    if (!string.IsNullOrWhiteSpace(val)) return val.Trim();

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
