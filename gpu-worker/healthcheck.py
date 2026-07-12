from config import WorkerConfig


def main() -> None:
    config = WorkerConfig.from_env()
    config.validate()
    print("gpu-worker config ok")


if __name__ == "__main__":
    main()
