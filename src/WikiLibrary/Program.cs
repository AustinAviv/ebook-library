using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using WikiLibrary;
using WikiLibrary.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// One HttpClient and one BookService for the whole app.
builder.Services.AddSingleton(new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.AddSingleton<BookService>();

var host = builder.Build();

// Fetch books.json ONCE at startup; after this every search/filter/page runs in memory.
var books = host.Services.GetRequiredService<BookService>();
await books.LoadAsync();

// Download counts load in the background and never block the page.
_ = books.LoadStatsAsync();

await host.RunAsync();
