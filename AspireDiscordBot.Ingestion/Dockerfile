# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY AspireDiscordBot.Core/AspireDiscordBot.Core.csproj AspireDiscordBot.Core/
COPY AspireDiscordBot.ServiceDefaults/AspireDiscordBot.ServiceDefaults.csproj AspireDiscordBot.ServiceDefaults/
COPY AspireDiscordBot.Ingestion/AspireDiscordBot.Ingestion.csproj AspireDiscordBot.Ingestion/
RUN dotnet restore AspireDiscordBot.Ingestion/AspireDiscordBot.Ingestion.csproj \
    --source https://api.nuget.org/v3/index.json

COPY AspireDiscordBot.Core AspireDiscordBot.Core
COPY AspireDiscordBot.ServiceDefaults AspireDiscordBot.ServiceDefaults
COPY AspireDiscordBot.Ingestion AspireDiscordBot.Ingestion
RUN dotnet publish AspireDiscordBot.Ingestion/AspireDiscordBot.Ingestion.csproj \
    --configuration Release \
    --no-restore \
    --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "AspireDiscordBot.Ingestion.dll"]
