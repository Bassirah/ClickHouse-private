import pytest

from helpers.cluster import ClickHouseCluster

cluster = ClickHouseCluster(__file__)
configured = cluster.add_instance("configured", main_configs=["configs/web_console.xml"])
custom_handler = cluster.add_instance("custom_handler", main_configs=["configs/console_handler.xml"])

DEFAULTS = {
    "source_code_url": "https://github.com/ClickHouse/ClickHouse/",
    "documentation_url": "https://clickhouse.com/docs/",
    "website_url": "https://clickhouse.com/",
    "cloud_url": "https://clickhouse.cloud/",
    "clickstack_url": "/clickstack/",
}


@pytest.fixture(scope="module", autouse=True)
def started_cluster():
    try:
        cluster.start()
        yield cluster
    finally:
        cluster.shutdown()


def test_configured_destinations():
    response = configured.http_request("console/config.json")
    assert response.status_code == 200
    assert response.headers["Content-Type"] == "application/json; charset=UTF-8"
    assert response.json() == {
        **DEFAULTS,
        "documentation_url": "https://docs.example.internal/clickhouse/",
        "cloud_url": "",
    }


def test_destinations_follow_config_reload():
    config_path = "/etc/clickhouse-server/config.d/web_console.xml"
    try:
        configured.replace_config(
            config_path,
            "<clickhouse><web_console><website_url>https://intranet.example.internal/</website_url></web_console></clickhouse>",
        )
        configured.query("SYSTEM RELOAD CONFIG")
        assert configured.http_request("console/config.json").json() == {
            **DEFAULTS,
            "website_url": "https://intranet.example.internal/",
        }
    finally:
        configured.replace_config(
            config_path,
            "<clickhouse><web_console><documentation_url>https://docs.example.internal/clickhouse/</documentation_url><cloud_url></cloud_url></web_console></clickhouse>",
        )
        configured.query("SYSTEM RELOAD CONFIG")


def test_console_handler_type():
    for path in ["console", "console/merges", "console/login?next=sql"]:
        response = custom_handler.http_request(path)
        assert response.status_code == 200
        assert "<title>ClickHouse Console</title>" in response.text
        assert response.headers["X-Test-Console"] == "yes"
        # Headers configured for the handler override the defaults of the console.
        assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
        assert response.headers["Cache-Control"] == "no-store"

    assert custom_handler.http_request("console/config.json").json() == DEFAULTS
    # `<defaults/>` keeps the other web UIs.
    assert custom_handler.http_request("dashboard").status_code == 200
