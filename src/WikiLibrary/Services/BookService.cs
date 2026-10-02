using System.Net.Http.Json;
using WikiLibrary.Models;

namespace WikiLibrary.Services;

/// <summary>
/// Holds the whole library in memory. Everything (search, filter, sort, paging)
/// runs in the browser, so it never needs another server request.
/// </summary>
public class BookService
{
    public const int PageSize = 50;

    private readonly HttpClient _http;
    private Dictionary<int, Book> _byId = new();
    private List<Book> _sorted = new();               // all books, A-Z by title
    private Dictionary<int, int> _downloads = new();  // id -> download count

    public BookService(HttpClient http) => _http = http;

    public bool IsLoaded { get; private set; }
    public string? LoadError { get; private set; }
    public IReadOnlyList<Book> All => _sorted;
    public int Count => _sorted.Count;
    public IReadOnlyList<(string Name, int Count)> Categories { get; private set; } = new List<(string, int)>();

    /// <summary>Raised when download counts arrive (so open pages can refresh).</summary>
    public event Action? StatsChanged;

    // ---------- loading ----------

    public async Task LoadAsync()
    {
        if (IsLoaded) return;
        try
        {
            var books = await _http.GetFromJsonAsync<List<Book>>("data/books.json") ?? new();
            _byId = books.ToDictionary(b => b.Id);
            _sorted = books.OrderBy(b => b.Title, StringComparer.OrdinalIgnoreCase).ToList();
            Categories = books
                .Where(b => b.HasCategory)
                .GroupBy(b => b.Category!)
                .Select(g => (Name: g.Key, Count: g.Count()))
                .OrderByDescending(c => c.Count).ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            IsLoaded = true;
        }
        catch (Exception ex)
        {
            LoadError = ex.Message;
        }
    }

    /// <summary>Fetches /api/stats once. Failure (e.g. local dev) is silently ignored.</summary>
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
        catch { /* counts just show as "—" */ }
    }

    // ---------- queries ----------

    public Book? GetById(int id) => _byId.GetValueOrDefault(id);

    /// <summary>Download count, or null if stats are unavailable.</summary>
    public int? GetDownloads(int id) =>
        _downloads.Count == 0 ? null : _downloads.GetValueOrDefault(id, 0);

    public Book? RandomBook() => _sorted.Count == 0 ? null : _sorted[Random.Shared.Next(_sorted.Count)];

    public IReadOnlyList<Book> Newest(int take) => _sorted.OrderByDescending(b => b.Id).Take(take).ToList();

    public IReadOnlyList<Book> InCategory(string category) =>
        _sorted.Where(b => string.Equals(b.Category, category, StringComparison.OrdinalIgnoreCase)).ToList();

    /// <summary>"A".."Z" for titles starting with a letter, "#" for everything else.</summary>
    public static string LetterOf(Book b)
    {
        var first = b.Title.TrimStart().FirstOrDefault();
        return char.IsAsciiLetter(first) ? char.ToUpperInvariant(first).ToString() : "#";
    }

    public IReadOnlyList<Book> ByLetter(string? letter) =>
        string.IsNullOrEmpty(letter) ? _sorted : _sorted.Where(b => LetterOf(b) == letter).ToList();

    /// <summary>Every search word must appear somewhere; title matches rank highest.</summary>
    public IReadOnlyList<Book> Search(string query)
    {
        var terms = query.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (terms.Length == 0) return Array.Empty<Book>();

        return _sorted
            .Select(b => (Book: b, Score: Score(b, terms)))
            .Where(x => x.Score > 0)
            .OrderByDescending(x => x.Score)
            .Select(x => x.Book)
            .ToList();
    }

    private static int Score(Book b, string[] terms)
    {
        int total = 0;
        foreach (var t in terms)
        {
            int s = 0;
            if (Has(b.Title, t)) s += 10;
            if (b.Author is not null && Has(b.Author, t)) s += 5;
            if (b.Category is not null && Has(b.Category, t)) s += 3;
            if (b.Description is not null && Has(b.Description, t)) s += 1;
            if (s == 0) return 0; // this word matched nothing -> not a result
            total += s;
        }
        return total;
    }

    private static bool Has(string text, string term) =>
        text.Contains(term, StringComparison.OrdinalIgnoreCase);

    /// <summary>Returns one page (1-based) of a list.</summary>
    public static List<T> Page<T>(IReadOnlyList<T> items, int page, int size = PageSize) =>
        items.Skip((Math.Max(page, 1) - 1) * size).Take(size).ToList();
}
