import click


@click.group()
def grp():
    pass


@grp.command("sub")
def sub():
    click.echo("sub")


@click.command()
@click.option("--n", default=1)
def main(n):
    click.echo(n)
