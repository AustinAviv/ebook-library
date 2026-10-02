using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.JSInterop;
using WikiLibrary.Models;

namespace WikiLibrary.Services;

public class BookService
{
    public const int PageSize = 6;
    private const int MaxQueryCacheSize = 64;

    private readonly HttpClient _http;
    private readonly IJSRuntime _js;
    private Dictionary<int, Book> _byId = new();
    private List<Book> _sorted = new();
    private Dictionary<int, int> _downloads = new();

    private Dictionary<string, List<Book>> _byLetterBuckets = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, HashSet<int>> _invertedIndex = new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, IReadOnlyList<Book>> _searchCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly LinkedList<string> _cacheLruOrder = new();

    public BookService(HttpClient http, IJSRuntime js)
    {
        _http = http;
        _js = js;
    }

    public bool IsLoaded { get; private set; }
    public string? LoadError { get; private set; }
    public IReadOnlyList<Book> All => _sorted;
    public int Count => _sorted.Count;
    public IReadOnlyList<(string Name, int Count)> Categories { get; private set; } = new List<(string, int)>();

    public event Action? StatsChanged;
    public event Action? LoadedChanged;

    public async Task EnsureLoadedAsync()
    {
        if (IsLoaded) return;
        await LoadAsync();
    }

    public async Task RetryAsync()
    {
        LoadError = null;
        IsLoaded = false;
        LoadedChanged?.Invoke();
        await LoadAsync();
    }

    public async Task LoadAsync()
    {
        try
        {
            var cachedJson = await _js.InvokeAsync<string?>("loadCatalogCache");
            if (!string.IsNullOrWhiteSpace(cachedJson))
            {
                var cachedBooks = JsonSerializer.Deserialize<List<Book>>(cachedJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (cachedBooks != null && cachedBooks.Count > 0)
                {
                    ApplyBooks(cachedBooks);
                    IsLoaded = true;
                    LoadError = null;
                    LoadedChanged?.Invoke();
                }
            }
        }
        catch { }

        Exception? lastError = null;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                var rawJson = await _http.GetStringAsync("data/books.json");
                var books = JsonSerializer.Deserialize<List<Book>>(rawJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();

                ApplyBooks(books);

                IsLoaded = true;
                LoadError = null;
                LoadedChanged?.Invoke();

                try
                {
                    await _js.InvokeVoidAsync("saveCatalogCache", rawJson);
                }
                catch { }

                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                await Task.Delay(250);
            }
        }

        if (!IsLoaded)
        {
            LoadError = lastError?.Message ?? "Unable to load library catalogue.";
            LoadedChanged?.Invoke();
        }
    }

    private void ApplyBooks(List<Book> books)
    {
        var validBooks = books.Where(b => b.Id > 0 && !string.IsNullOrWhiteSpace(b.Title)).ToList();

        _byId = validBooks.ToDictionary(b => b.Id);
        _sorted = validBooks.OrderBy(b => b.Title, StringComparer.OrdinalIgnoreCase).ToList();

        BuildLetterBuckets(_sorted);
        BuildInvertedIndex(_sorted);

        Categories = validBooks
            .Where(b => b.HasCategory)
            .GroupBy(b => b.Category!)
            .Select(g => (Name: g.Key, Count: g.Count()))
            .OrderByDescending(c => c.Count).ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private void BuildLetterBuckets(List<Book> books)
    {
        var buckets = new Dictionary<string, List<Book>>(StringComparer.OrdinalIgnoreCase);
        foreach (var b in books)
        {
            var letter = LetterOf(b);
            if (!buckets.TryGetValue(letter, out var list))
            {
                list = new List<Book>();
                buckets[letter] = list;
            }
            list.Add(b);
        }
        _byLetterBuckets = buckets;
    }

    private void BuildInvertedIndex(List<Book> books)
    {
        var index = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);

        foreach (var b in books)
        {
            var text = b.Title;
            if (b.HasAuthor) text += " " + b.Author;
            if (b.HasCategory) text += " " + b.Category;

            var tokens = text.Split(new[] { ' ', '-', '_', '.', ',', ':', ';', '(', ')', '[', ']' },
                                   StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            foreach (var token in tokens)
            {
                var clean = token.ToLowerInvariant();
                if (clean.Length < 2) continue;

                if (!index.TryGetValue(clean, out var set))
                {
                    set = new HashSet<int>();
                    index[clean] = set;
                }
                set.Add(b.Id);

                for (int len = 2; len <= Math.Min(clean.Length, 6); len++)
                {
                    var prefix = clean[..len];
                    if (!index.TryGetValue(prefix, out var pSet))
                    {
                        pSet = new HashSet<int>();
                        index[prefix] = pSet;
                    }
                    pSet.Add(b.Id);
                }
            }
        }

        _invertedIndex = index;
    }

    public async Task LoadStatsAsync()
    {
        try
        {
            var raw = await _http.GetFromJsonAsync<Dictionary<string, int>>("api/stats");
            if (raw is null) return;
            _downloads = raw.Where(kv => int.TryParse(kv.Key, out _))
                            .ToDictionary(kv => int.Parse(kv.Key), kv => kv.Value);
            StatsChanged?.Invoke();
        }
        catch { }
    }

    public Book? GetById(int id) => _byId.GetValueOrDefault(id);

    public int? GetDownloads(int id) =>
        _downloads.Count == 0 ? null : _downloads.GetValueOrDefault(id, 0);

    public Book? RandomBook() => _sorted.Count == 0 ? null : _sorted[Random.Shared.Next(_sorted.Count)];

    public IReadOnlyList<Book> Newest(int take) => _sorted.OrderByDescending(b => b.Id).Take(take).ToList();

    public IReadOnlyList<Book> InCategory(string category) =>
        _sorted.Where(b => string.Equals(b.Category, category, StringComparison.OrdinalIgnoreCase)).ToList();

    public static string LetterOf(Book b)
    {
        var first = b.Title.TrimStart().FirstOrDefault();
        return char.IsAsciiLetter(first) ? char.ToUpperInvariant(first).ToString() : "#";
    }

    public IReadOnlyList<Book> ByLetter(string? letter)
    {
        if (string.IsNullOrEmpty(letter)) return _sorted;
        return _byLetterBuckets.GetValueOrDefault(letter) ?? (IReadOnlyList<Book>)Array.Empty<Book>();
    }

    public IReadOnlyList<Book> Search(string query)
    {
        var cleanQuery = query.Trim();
        if (string.IsNullOrWhiteSpace(cleanQuery)) return Array.Empty<Book>();

        lock (_searchCache)
        {
            if (_searchCache.TryGetValue(cleanQuery, out var cachedResults))
            {
                _cacheLruOrder.Remove(cleanQuery);
                _cacheLruOrder.AddLast(cleanQuery);
                return cachedResults;
            }
        }

        var terms = cleanQuery.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (terms.Length == 0) return Array.Empty<Book>();

        HashSet<int>? candidateIds = null;
        foreach (var t in terms)
        {
            var cleanTerm = t.ToLowerInvariant();
            if (_invertedIndex.TryGetValue(cleanTerm, out var matchingIds))
            {
                if (candidateIds is null)
                    candidateIds = new HashSet<int>(matchingIds);
                else
                    candidateIds.IntersectWith(matchingIds);
            }
            else
            {
                var fallbackIds = _sorted
                    .Where(b => b.Title.Contains(t, StringComparison.OrdinalIgnoreCase) ||
                                (b.Author != null && b.Author.Contains(t, StringComparison.OrdinalIgnoreCase)))
                    .Select(b => b.Id);

                if (candidateIds is null)
                    candidateIds = new HashSet<int>(fallbackIds);
                else
                    candidateIds.IntersectWith(fallbackIds);
            }

            if (candidateIds.Count == 0) break;
        }

        var matches = (candidateIds ?? Enumerable.Empty<int>())
            .Select(id => _byId[id])
            .Select(b => (Book: b, Score: CalculateScore(b, terms)))
            .OrderByDescending(x => x.Score)
            .Select(x => x.Book)
            .ToList();

        lock (_searchCache)
        {
            if (_searchCache.Count >= MaxQueryCacheSize && _cacheLruOrder.First != null)
            {
                var oldest = _cacheLruOrder.First.Value;
                _cacheLruOrder.RemoveFirst();
                _searchCache.Remove(oldest);
            }
            _searchCache[cleanQuery] = matches;
            _cacheLruOrder.AddLast(cleanQuery);
        }

        return matches;
    }

    private static int CalculateScore(Book b, string[] terms)
    {
        int score = 0;
        foreach (var t in terms)
        {
            if (b.Title.Equals(t, StringComparison.OrdinalIgnoreCase)) score += 50;
            else if (b.Title.StartsWith(t, StringComparison.OrdinalIgnoreCase)) score += 25;
            else if (b.Title.Contains(t, StringComparison.OrdinalIgnoreCase)) score += 10;

            if (b.Author != null && b.Author.Contains(t, StringComparison.OrdinalIgnoreCase)) score += 5;
            if (b.Category != null && b.Category.Contains(t, StringComparison.OrdinalIgnoreCase)) score += 3;
        }
        return score;
    }

    public static List<T> Page<T>(IReadOnlyList<T> items, int page, int size = PageSize) =>
        items.Skip((Math.Max(page, 1) - 1) * size).Take(size).ToList();
}
